import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DraftRepository } from "@/modules/publishing/adapters/sqlite/drafts";
import { BookDeletionRepository } from "@/modules/catalog/adapters/sqlite/book-deletions";
import { JobRepository } from "@/modules/publishing/adapters/sqlite/jobs";
import { acceptBookDeletion as acceptBookDeletionWithPorts } from "@/modules/catalog/adapters/sqlite/book-deletion";
import { createBookDeletionToken } from "@/modules/catalog/core/book-deletion-token";
import { permanentlyCleanupBook as removePermanentBookFiles } from "@/modules/catalog/adapters/filesystem/permanent-book-cleanup";
import { SqliteBookPublishingCleanup } from "@/modules/publishing/adapters/sqlite/book-cleanup";
import {
  completeBookDeletionFailure,
  failQueuedBookDeletion,
  finalizeBookDeletion,
  markBookDeletionPurging,
  retryBookDeletion,
} from "@/composition/book-deletion";
import { LibraryService } from "@/modules/catalog/adapters/sqlite/library";
import { PublishedBookService } from "@/modules/reader/adapters/filesystem/published-book";
import {
  removeExactContainedTree,
  UnsafePermanentRemovalTargetError,
} from "@/platform/filesystem/permanent-removal";

import { withMigratedTestDatabase } from "../../helpers/database";
import {
  setupPublicationFixture,
  publishReadyCandidateForTest,
} from "../../helpers/publication";
import { saveDocument } from "@/modules/publishing/adapters/sqlite/save-document";

function acceptBookDeletion(
  input: Omit<
    Parameters<typeof acceptBookDeletionWithPorts>[0],
    "deletionTasks" | "publishingCleanup"
  >,
) {
  const publishingCleanup = new SqliteBookPublishingCleanup(input.database);
  return acceptBookDeletionWithPorts({
    ...input,
    deletionTasks: publishingCleanup,
    publishingCleanup,
  });
}

async function permanentlyCleanupBook(input: {
  readonly bookId: number;
  readonly database: Parameters<typeof finalizeBookDeletion>[0]["database"];
  readonly jobId: string;
  readonly layout: Parameters<typeof removePermanentBookFiles>[0]["layout"];
  readonly nowMs: number;
}) {
  const jobs = new JobRepository(input.database);
  const claimed = jobs.claimNext({
    leaseOwner: "worker:deletion-test",
    nowMs: input.nowMs - 1,
  });
  if (!claimed || claimed.id !== input.jobId) {
    throw new Error("Expected cleanup job to be claimed");
  }
  markBookDeletionPurging(input.database, input.jobId, input.nowMs - 1);
  let result;
  try {
    result = await removePermanentBookFiles({
      bookId: input.bookId,
      layout: input.layout,
      publishingCleanup: new SqliteBookPublishingCleanup(input.database),
    });
  } catch (error) {
    const code =
      error instanceof Error ? error.message : "CLEANUP_FILESYSTEM_IO";
    const job = jobs.get(input.jobId);
    if (job?.state === "running") {
      completeBookDeletionFailure({
        database: input.database,
        errorClass: "infrastructure",
        errorCode: code,
        job,
        leaseOwner: "worker:deletion-test",
        nowMs: input.nowMs,
      });
    }
    throw error;
  }
  finalizeBookDeletion({
    bookId: input.bookId,
    database: input.database,
    jobId: input.jobId,
    leaseOwner: "worker:deletion-test",
    nowMs: input.nowMs,
  });
  return result;
}

describe("permanent book cleanup", () => {
  it("removes files before relational content and retains one content-free tombstone", async () => {
    await withMigratedTestDatabase(async ({ database }, dataRoot) => {
      const drafts = new DraftRepository(database);
      const book = drafts.createBook({ nowMs: 1_000, title: "Cleanup me" });
      const importId = "imp_abcdefghijklmnop";
      database
        .prepare(
          `INSERT INTO imports (
            id, original_name, state, upload_rel_path, upload_size_bytes, upload_sha256,
            source_path, book_id, safe_error_code,
            created_at, updated_at, expires_at
          ) VALUES (?, 'fixture.zip', 'draft_ready', ?, 3, ?, NULL, ?, NULL, 1000, 1000, 9000)`,
        )
        .run(
          importId,
          `tmp/uploads/${importId}/original.zip`,
          "a".repeat(64),
          book.id,
        );
      const accepted = acceptBookDeletion({
        actorUserId: "admin",
        bookId: book.id,
        confirmationTitle: book.title,
        database,
        idempotencyKey: "delete-cleanup-request-0001",
        mutationToken: createBookDeletionToken({
          alias: book.alias,
          bookId: book.id,
          currentVersionId: book.currentVersionId,
          draftImportId: book.draftImportId,
          title: book.title,
          updatedAtMs: book.updatedAtMs,
        }),
        nowMs: 2_000,
      });
      const bookDirectory = resolve(
        dataRoot.layout.bookDirectory,
        String(book.id),
      );
      const uploadDirectory = resolve(
        dataRoot.layout.uploadDirectory,
        importId,
      );
      await mkdir(bookDirectory, { recursive: true });
      await mkdir(uploadDirectory, { recursive: true });
      await writeFile(resolve(bookDirectory, "private.md"), "secret");
      await writeFile(resolve(uploadDirectory, "original.zip"), "zip");

      await expect(
        permanentlyCleanupBook({
          bookId: book.id,
          database,
          jobId: accepted.jobId,
          layout: dataRoot.layout,
          nowMs: 3_000,
        }),
      ).resolves.toMatchObject({ removedUploadDirectories: 1 });
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM books").get(),
      ).toEqual({ count: 0 });
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM imports").get(),
      ).toEqual({ count: 0 });
      expect(
        new BookDeletionRepository(database).findById(accepted.deletionId),
      ).toMatchObject({
        bookId: book.id,
        completedAtMs: 3_000,
        state: "completed",
      });
      expect(
        database
          .prepare("SELECT book_id FROM jobs WHERE id = ?")
          .get(accepted.jobId),
      ).toEqual({ book_id: null });
      expect(database.pragma("foreign_key_check")).toEqual([]);
    });
  });

  it("purges the complete IR/save/preview/version/search relationship graph", async () => {
    await withMigratedTestDatabase(async ({ database }, dataRoot) => {
      const fixture = setupPublicationFixture(database);
      const book = fixture.book;
      const drafts = fixture.drafts;
      await publishReadyCandidateForTest({
        database,
        bookId: book.id,
        nowMs: 1500,
      });
      database
        .prepare(
          `INSERT INTO original_files (id,book_id,import_id,role,storage_rel_path,original_name,media_type,size_bytes,sha256,created_at)
        VALUES ('file_fullgraphfixture',?,?,'mineru_zip',?,'private.zip','application/zip',3,?,1400)`,
        )
        .run(
          book.id,
          fixture.imported.id,
          `books/${book.id}/originals/file_fullgraphfixture`,
          "d".repeat(64),
        );
      database
        .prepare(
          "INSERT INTO book_resources (id,book_id,storage_rel_path,media_type,size_bytes,sha256,created_at) VALUES (?,?,?,'image/png',3,?,1400)",
        )
        .run(
          "res_fullgraphfixture0001",
          book.id,
          `books/${book.id}/assets/res_fullgraphfixture0001.png`,
          "e".repeat(64),
        );
      saveDocument({
        requestId: "save_before_delete_0001",
        database,
        bookId: book.id,
        expectedUpdatedAt: fixture.document.updated_at,
        patch: { metadata: { title: "Pending edit" } },
        nowMs: 1600,
      });
      const current = drafts.requireBook(book.id);
      const accepted = acceptBookDeletion({
        actorUserId: "admin",
        bookId: book.id,
        confirmationTitle: current.title,
        database,
        idempotencyKey: "delete-full-graph-0001",
        mutationToken: createBookDeletionToken({
          alias: current.alias,
          bookId: current.id,
          currentVersionId: current.currentVersionId,
          draftImportId: current.draftImportId,
          title: current.title,
          updatedAtMs: current.updatedAtMs,
        }),
        nowMs: 2_000,
      });
      expect(new LibraryService(database).publicLibrary().entries).toEqual([]);
      expect(() =>
        new PublishedBookService(database, dataRoot.layout).resolveCurrent(
          String(book.id),
          { allowed: true },
        ),
      ).toThrow(expect.objectContaining({ code: "NOT_FOUND", status: 404 }));

      await permanentlyCleanupBook({
        bookId: book.id,
        database,
        jobId: accepted.jobId,
        layout: dataRoot.layout,
        nowMs: 3_000,
      });
      for (const table of [
        "books",
        "imports",
        "book_resources",
        "book_documents",
        "book_blocks",
        "book_nodes",
        "document_commands",
        "original_files",
        "book_versions",
        "book_version_presentations",
        "search_short_fields",
        "audit_events",
      ]) {
        expect(
          database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
          table,
        ).toEqual({ count: 0 });
      }
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM search_fts").get(),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM jobs
             WHERE book_id IS NOT NULL OR import_id IS NOT NULL
                OR version_id IS NOT NULL OR captured_input_path IS NOT NULL
                OR captured_source_updated_at IS NOT NULL
                OR captured_current_version_id IS NOT NULL`,
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM book_deletions").get(),
      ).toEqual({ count: 1 });
      expect(database.pragma("foreign_key_check")).toEqual([]);
    });
  });

  it("refuses root, escaped and symlink targets without following them", async () => {
    await withMigratedTestDatabase(async (_database, dataRoot) => {
      await expect(
        removeExactContainedTree({
          root: dataRoot.layout.bookDirectory,
          target: dataRoot.layout.bookDirectory,
        }),
      ).rejects.toBeInstanceOf(UnsafePermanentRemovalTargetError);
      await expect(
        removeExactContainedTree({
          root: dataRoot.layout.bookDirectory,
          target: dataRoot.layout.root,
        }),
      ).rejects.toBeInstanceOf(UnsafePermanentRemovalTargetError);
      const target = resolve(dataRoot.layout.bookDirectory, "999");
      await symlink(dataRoot.layout.databaseDirectory, target);
      await expect(
        removeExactContainedTree({
          root: dataRoot.layout.bookDirectory,
          target,
        }),
      ).rejects.toMatchObject({ code: "CLEANUP_UNSAFE_TARGET" });

      const externalParent = resolve(
        dataRoot.layout.databaseDirectory,
        "outside-cleanup",
      );
      await mkdir(externalParent);
      const externalFile = resolve(externalParent, "preserved");
      await writeFile(externalFile, "keep");
      const linkedParent = resolve(
        dataRoot.layout.bookDirectory,
        "linked-parent",
      );
      await symlink(externalParent, linkedParent);
      await expect(
        removeExactContainedTree({
          root: dataRoot.layout.bookDirectory,
          target: resolve(linkedParent, "preserved"),
        }),
      ).rejects.toBeInstanceOf(UnsafePermanentRemovalTargetError);
      await expect(readFile(externalFile, "utf8")).resolves.toBe("keep");
    });
  });

  it("keeps the irreversible barrier and a safe retryable state after unsafe storage", async () => {
    await withMigratedTestDatabase(async ({ database }, dataRoot) => {
      const drafts = new DraftRepository(database);
      const book = drafts.createBook({ nowMs: 1_000, title: "Unsafe target" });
      const accepted = acceptBookDeletion({
        actorUserId: "admin",
        bookId: book.id,
        confirmationTitle: book.title,
        database,
        idempotencyKey: "delete-unsafe-target-0001",
        mutationToken: createBookDeletionToken({
          alias: null,
          bookId: book.id,
          currentVersionId: null,
          draftImportId: null,
          title: book.title,
          updatedAtMs: book.updatedAtMs,
        }),
        nowMs: 2_000,
      });
      await symlink(
        dataRoot.layout.databaseDirectory,
        resolve(dataRoot.layout.bookDirectory, String(book.id)),
      );

      await expect(
        permanentlyCleanupBook({
          bookId: book.id,
          database,
          jobId: accepted.jobId,
          layout: dataRoot.layout,
          nowMs: 3_000,
        }),
      ).rejects.toThrow("CLEANUP_UNSAFE_TARGET");
      expect(
        new BookDeletionRepository(database).findById(accepted.deletionId),
      ).toMatchObject({
        safeErrorCode: "CLEANUP_UNSAFE_TARGET",
        state: "failed",
      });
      expect(drafts.findBook(book.id)).toBeNull();
      expect(
        database
          .prepare("SELECT deletion_requested_at FROM books WHERE id = ?")
          .get(book.id),
      ).toEqual({ deletion_requested_at: 2_000 });
    });
  });

  it("moves a failed irreversible cleanup tombstone to one explicit retry", async () => {
    await withMigratedTestDatabase(async ({ database }, dataRoot) => {
      const drafts = new DraftRepository(database);
      const book = drafts.createBook({ nowMs: 1_000, title: "Retry cleanup" });
      const accepted = acceptBookDeletion({
        actorUserId: "admin",
        bookId: book.id,
        confirmationTitle: book.title,
        database,
        idempotencyKey: "delete-cleanup-retry-0001",
        mutationToken: createBookDeletionToken({
          alias: book.alias,
          bookId: book.id,
          currentVersionId: null,
          draftImportId: null,
          title: book.title,
          updatedAtMs: book.updatedAtMs,
        }),
        nowMs: 2_000,
      });
      expect(
        failQueuedBookDeletion({
          database,
          errorClass: "infrastructure",
          errorCode: "JOB_HANDLER_FAILED",
          jobId: accepted.jobId,
          nowMs: 2_500,
        }),
      ).toMatchObject({ state: "failed" });
      expect(
        new BookDeletionRepository(database).findById(accepted.deletionId),
      ).toMatchObject({
        safeErrorCode: "CLEANUP_INTERRUPTED",
        state: "failed",
      });
      const retry = retryBookDeletion({
        automatic: false,
        database,
        jobId: accepted.jobId,
        nowMs: 3_000,
      });
      expect(retry).toMatchObject({
        bookId: book.id,
        kind: "purge_book",
        state: "queued",
      });
      expect(
        new BookDeletionRepository(database).findById(accepted.deletionId),
      ).toMatchObject({
        cleanupJobId: retry.id,
        safeErrorCode: null,
        state: "pending",
      });
      await permanentlyCleanupBook({
        bookId: book.id,
        database,
        jobId: retry.id,
        layout: dataRoot.layout,
        nowMs: 4_000,
      });
      expect(
        new BookDeletionRepository(database).findById(accepted.deletionId),
      ).toMatchObject({ state: "completed" });
    });
  });
});
