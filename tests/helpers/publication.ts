import type Database from "better-sqlite3";
import { dirname, resolve } from "node:path";

import { SqliteBookAccessRepository } from "@/modules/catalog/adapters/sqlite/book-access";
import { setBookAccess } from "@/modules/catalog/application/commands/set-book-access";
import type { BookVersionPresentation } from "@/modules/catalog/application/catalog-api";
import { BookPresentationRepository } from "@/modules/catalog/adapters/sqlite/book-presentations";
import { BuildPublicationRepository } from "@/modules/publishing/adapters/sqlite/build-publication";
import { BuildRepository } from "@/modules/publishing/adapters/sqlite/builds";
import { DraftRepository } from "@/modules/publishing/adapters/sqlite/drafts";
import { ImportRepository } from "@/modules/publishing/adapters/sqlite/imports";
import { JobRepository } from "@/modules/publishing/adapters/sqlite/jobs";
import { VersionRepository } from "@/modules/publishing/adapters/sqlite/versions";
import {
  m1PublishPolicy,
  publishBuild,
} from "@/modules/publishing/application/publishing-api";
import type { SearchSpool } from "@/modules/publishing/core/publication/search-model";
import { withImmediateTransaction } from "@/platform/sqlite/immediate-transaction";
import type { StorageLayout } from "@/platform/filesystem/storage-layout";
import { smallBook } from "./ir-book";
import { DocumentRepository } from "@/modules/publishing/adapters/sqlite/documents";

const hash = "a".repeat(64);
export const publicationTestUpdatedAt = 1000;
export const publicationTestVersionId = "ver_candidate_publish_test_0001";
const blockId = "blk_stale_publish_test_0001";
export const publicationTestLeaseOwner = "worker:test";

export function presentationForTest(
  bookId: number,
  versionId = publicationTestVersionId,
): BookVersionPresentation {
  return Object.freeze({
    alias: null,
    bookId,
    sourceUpdatedAt: publicationTestUpdatedAt,
    coverResourceId: null,
    createdAtMs: 11,
    firstPageAlias: null,
    firstPageId: 1,
    metadataJson: "{}\n",
    projectionSchemaVersion: 3,
    projectionSha256: hash,
    title: "Book",
    tocEntryCount: 0,
    tocPreviewJson: "[]\n",
    versionId,
  });
}

function spool(bookId: number, versionId: string): SearchSpool {
  return {
    digest: hash,
    ftsRows: [
      {
        authors: "",
        blockId,
        body: "Body",
        bookId,
        heading: "Chapter",
        kind: "paragraph",
        ordinal: 0,
        pageId: 1,
        title: "Book",
        versionId,
      },
    ],
    schemaVersion: 1,
    shortRows: [
      {
        blockId: null,
        bookId,
        kind: "title",
        normalizedText: "Book",
        ordinal: 0,
        pageId: 1,
        versionId,
      },
    ],
  };
}

export function setupPublicationFixture(
  database: Database.Database,
  options: { readonly registerReady?: boolean } = {},
) {
  const drafts = new DraftRepository(database);
  const book = drafts.createBook({ nowMs: 1, title: "Book" });
  const imported = new ImportRepository(database).createUploaded({
    bookId: book.id,
    expiresAtMs: 10_000,
    id: "imp_candidate_publish_test_0001",
    nowMs: 2,
    originalName: "fixture.zip",
    uploadRelativePath: "tmp/import.zip",
    uploadSha256: hash,
    uploadSizeBytes: 1,
  });
  const layout = publicationLayoutForTest(database);
  const document = smallBook(book.id, publicationTestUpdatedAt);
  new DocumentRepository(database).insert(document);
  database
    .prepare("UPDATE books SET draft_import_id=? WHERE id=?")
    .run(imported.id, book.id);

  const candidates = new BuildRepository(database);
  const candidate = candidates.createForDocument({
    bookId: book.id,
    sourceUpdatedAt: publicationTestUpdatedAt,
    nowMs: 5,
    importId: imported.id,
  });
  database
    .prepare("UPDATE jobs SET version_id = ? WHERE id = ? AND state = 'queued'")
    .run(publicationTestVersionId, candidate.jobId);
  const jobs = new JobRepository(database);
  const claimed = jobs.claimNext({
    leaseOwner: publicationTestLeaseOwner,
    nowMs: 6,
  });
  if (claimed?.id !== candidate.jobId) {
    throw new Error("BUILD_JOB_WAS_NOT_CLAIMED");
  }

  if (options.registerReady !== false) {
    withImmediateTransaction(database, () => {
      new VersionRepository(database).registerReadyWithSearch({
        bookId: book.id,
        compilerVersion: "compiler-v8",
        completeAtMs: 11,
        sourceUpdatedAt: publicationTestUpdatedAt,
        createdByJobId: candidate.jobId,
        expectedSearchBlockIds: [blockId],
        manifestSchemaVersion: 5,
        manifestSha256: hash,
        versionMarkerSha256: hash,
        previewVersion: "draft-preview-v8",
        readerVersion: "mirawind-reader-v5-tailwind-4.3.3",
        predecessorVersionId: null,
        presentation: presentationForTest(book.id),
        presentationWriter: new BookPresentationRepository(database),
        rendererVersion: "semantic-html-v8-katex-0.18.1",
        semanticDigest: hash,
        importId: imported.id,
        spool: spool(book.id, publicationTestVersionId),
        versionId: publicationTestVersionId,
        versionRelativePath: `books/1/builds/${publicationTestVersionId}`,
      });
      jobs.completeSuccess({
        jobId: candidate.jobId,
        leaseOwner: publicationTestLeaseOwner,
        nowMs: 11,
      });
    });
  }

  const candidateJob = jobs.get(candidate.jobId);
  if (!candidateJob) throw new Error("BUILD_JOB_MISSING");
  return {
    book,
    document,
    imported,
    layout,
    build: candidates.require(publicationTestVersionId),
    candidateJob,
    candidates,
    drafts,
    jobs,
  };
}

export async function publishReadyCandidateForTest(input: {
  readonly access?: "private" | "public";
  readonly actorUserId?: string | null;
  readonly bookId: number;
  readonly database: Database.Database;
  readonly expectedUpdatedAt?: number;
  readonly buildId?: string;
  readonly nowMs: number;
}) {
  const expectedUpdatedAt =
    input.expectedUpdatedAt ??
    new DocumentRepository(input.database).timestamp(input.bookId);
  const candidate = new BuildRepository(input.database).findCurrent(
    input.bookId,
  );
  const buildId = input.buildId ?? candidate?.id;
  if (!buildId) throw new Error("BUILD_MISSING");
  const published = await publishBuild({
    actorUserId: input.actorUserId ?? null,
    bookId: input.bookId,
    expectedUpdatedAt,
    buildId,
    nowMs: input.nowMs,
    policy: m1PublishPolicy,
    publication: new BuildPublicationRepository(input.database),
  });
  if ((input.access ?? "public") === "public") {
    setBookAccess({
      access: "public",
      actorUserId: input.actorUserId ?? null,
      bookId: input.bookId,
      books: new SqliteBookAccessRepository(input.database),
      nowMs: input.nowMs,
    });
  }
  return published;
}

export function publicationLayoutForTest(
  database: Database.Database,
): StorageLayout {
  const root = dirname(dirname(database.name));
  return {
    root,
    databaseDirectory: resolve(root, "db"),
    bookDirectory: resolve(root, "books"),
    temporaryDirectory: resolve(root, "tmp"),
    uploadDirectory: resolve(root, "tmp/uploads"),
  };
}
