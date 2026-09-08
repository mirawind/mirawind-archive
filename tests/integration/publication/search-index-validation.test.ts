import { describe, expect, it } from "vitest";

import type { SearchSpool } from "@/modules/publishing/core/publication/search-model";
import { DraftRepository } from "@/modules/publishing/adapters/sqlite/drafts";
import { ImportRepository } from "@/modules/publishing/adapters/sqlite/imports";
import { JobRepository } from "@/modules/publishing/adapters/sqlite/jobs";
import { VersionRepository } from "@/modules/publishing/adapters/sqlite/versions";
import { BookPresentationRepository } from "@/modules/catalog/adapters/sqlite/book-presentations";

import { withMigratedTestDatabase } from "../../helpers/database.js";
import { presentationForTest } from "../../helpers/publication.js";

const hash = "a".repeat(64);
const versionId = "ver_search_index_test_0001";
const secondVersionId = "ver_search_index_test_0002";
const blockId = "blk_search_index_test_0001";

function spool(input: {
  readonly bookId: number;
  readonly versionId: string;
}): SearchSpool {
  return {
    digest: hash,
    ftsRows: [
      {
        authors: "Author",
        blockId,
        body: "中文正文",
        bookId: input.bookId,
        heading: "Chapter",
        kind: "paragraph",
        ordinal: 0,
        pageId: 1,
        title: "Book",
        versionId: input.versionId,
      },
    ],
    schemaVersion: 1,
    shortRows: [
      {
        blockId: null,
        bookId: input.bookId,
        kind: "title",
        normalizedText: "Book",
        ordinal: 0,
        pageId: 1,
        versionId: input.versionId,
      },
    ],
  };
}

describe("ready-version and search index transaction", () => {
  it("validates row counts and exact block IDs and rolls everything back on failure", () =>
    withMigratedTestDatabase(({ database }) => {
      const drafts = new DraftRepository(database);
      const book = drafts.createBook({ nowMs: 1, title: "Book" });
      const imported = new ImportRepository(database).createUploaded({
        bookId: book.id,
        expiresAtMs: 10_000,
        id: "imp_search_index_test_0001",
        nowMs: 2,
        originalName: "fixture.zip",
        uploadRelativePath: "tmp/import.zip",
        uploadSha256: hash,
        uploadSizeBytes: 1,
      });
      const jobs = new JobRepository(database);
      const firstJob = jobs.create({
        bookId: book.id,
        capturedSourceUpdatedAt: 1000,
        importId: imported.id,
        kind: "build_book",
        nowMs: 5,
        versionId,
      });
      const versions = new VersionRepository(database);
      jobs.claimNext({ leaseOwner: "test", nowMs: 5 });
      const ready = versions.registerReadyWithSearch({
        bookId: book.id,
        compilerVersion: "compiler-v8",
        completeAtMs: 6,
        sourceUpdatedAt: 1000,
        createdByJobId: firstJob.id,
        expectedSearchBlockIds: [blockId],
        manifestSchemaVersion: 5,
        manifestSha256: hash,
        versionMarkerSha256: hash,
        semanticDigest: hash,
        previewVersion: "draft-preview-v8",
        readerVersion: "mirawind-reader-v5-tailwind-4.3.3",
        predecessorVersionId: null,
        presentation: presentationForTest(book.id, versionId),
        presentationWriter: new BookPresentationRepository(database),
        rendererVersion: "semantic-html-v8-katex-0.18.1",
        importId: imported.id,
        spool: spool({ bookId: book.id, versionId }),
        versionId,
        versionRelativePath: `books/1/builds/${versionId}`,
      });
      expect(ready.state).toBe("ready");
      jobs.completeSuccess({
        jobId: firstJob.id,
        leaseOwner: "test",
        nowMs: 6,
      });
      expect(jobs.get(firstJob.id)?.versionId).toBe(versionId);
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM search_fts WHERE version_id = ?",
          )
          .get(versionId),
      ).toEqual({ count: 1 });

      database
        .prepare("UPDATE book_versions SET state = 'discarded' WHERE id = ?")
        .run(versionId);

      const secondJob = jobs.create({
        bookId: book.id,
        capturedSourceUpdatedAt: 1000,
        capturedCurrentVersionId: versionId,
        importId: imported.id,
        kind: "build_book",
        nowMs: 7,
        versionId: secondVersionId,
      });
      expect(() =>
        versions.registerReadyWithSearch({
          bookId: book.id,
          compilerVersion: "compiler-v8",
          completeAtMs: 8,
          sourceUpdatedAt: 1000,
          createdByJobId: secondJob.id,
          expectedSearchBlockIds: ["blk_search_index_missing_0001"],
          manifestSchemaVersion: 5,
          manifestSha256: hash,
          versionMarkerSha256: hash,
          semanticDigest: hash,
          previewVersion: "draft-preview-v8",
          readerVersion: "mirawind-reader-v5-tailwind-4.3.3",
          predecessorVersionId: versionId,
          presentation: presentationForTest(book.id, secondVersionId),
          presentationWriter: new BookPresentationRepository(database),
          rendererVersion: "semantic-html-v8-katex-0.18.1",
          importId: imported.id,
          spool: spool({ bookId: book.id, versionId: secondVersionId }),
          versionId: secondVersionId,
          versionRelativePath: `books/1/builds/${secondVersionId}`,
        }),
      ).toThrow("SEARCH_BLOCK_ID_SET_MISMATCH");
      expect(versions.find(secondVersionId)).toBeNull();
      expect(jobs.get(secondJob.id)?.versionId).toBe(secondVersionId);
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM search_fts WHERE version_id = ?",
          )
          .get(secondVersionId),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM book_version_presentations WHERE version_id = ?`,
          )
          .get(secondVersionId),
      ).toEqual({ count: 0 });
    }));
});
