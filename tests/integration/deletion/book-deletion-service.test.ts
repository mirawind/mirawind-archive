import { describe, expect, it } from "vitest";

import { DraftRepository } from "@/modules/publishing/adapters/sqlite/drafts";
import { JobRepository } from "@/modules/publishing/adapters/sqlite/jobs";
import { serializeJobStatus } from "@/modules/publishing/adapters/sqlite/job-status";
import { SafeApplicationError } from "@/domain/errors";
import { acceptBookDeletion as acceptBookDeletionWithPorts } from "@/modules/catalog/adapters/sqlite/book-deletion";
import { SqliteBookPublishingCleanup } from "@/modules/publishing/adapters/sqlite/book-cleanup";
import { createBookDeletionToken } from "@/modules/catalog/core/book-deletion-token";
import { LibraryService } from "@/modules/catalog/adapters/sqlite/library";
import {
  completeBookDeletionInterruption,
  markBookDeletionPurging,
} from "@/composition/book-deletion";
import { withImmediateTransaction } from "@/platform/sqlite/immediate-transaction";

import { withMigratedTestDatabase } from "../../helpers/database";
import {
  publishReadyCandidateForTest,
  setupPublicationFixture,
} from "../../helpers/publication";

function token(book: ReturnType<DraftRepository["createBook"]>): string {
  return createBookDeletionToken({
    alias: book.alias,
    bookId: book.id,
    currentVersionId: book.currentVersionId,
    draftImportId: book.draftImportId,
    title: book.title,
    updatedAtMs: book.updatedAtMs,
  });
}

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

describe("permanent book deletion acceptance", () => {
  it("atomically hides the book, releases its alias and creates one content-free tombstone task", async () => {
    await withMigratedTestDatabase(({ database }) => {
      const drafts = new DraftRepository(database);
      const book = drafts.createBook({ nowMs: 1_000, title: "水与风" });
      database
        .prepare("UPDATE books SET alias = 'water-wind' WHERE id = ?")
        .run(book.id);
      const current = drafts.requireBook(book.id);
      const competing = new JobRepository(database).create({
        bookId: book.id,
        kind: "purge_book",
        nowMs: 1_100,
      });
      const result = acceptBookDeletion({
        actorUserId: "admin",
        bookId: book.id,
        confirmationTitle: "水与风",
        database,
        idempotencyKey: "delete-book-request-0001",
        mutationToken: token(current),
        nowMs: 2_000,
      });

      expect(result).toMatchObject({
        state: "pending",
        taskUrl: "/manage/tasks",
      });
      expect(
        new LibraryService(database).administratorLibrary({
          afterBookId: null,
          limit: 100,
        }).entries,
      ).toEqual([]);
      expect(
        database
          .prepare(
            "SELECT alias, deletion_requested_at FROM books WHERE id = ?",
          )
          .get(book.id),
      ).toEqual({ alias: null, deletion_requested_at: 2_000 });
      expect(new JobRepository(database).get(competing.id)?.state).toBe(
        "canceled",
      );
      const cleanupJob = new JobRepository(database).get(result.jobId);
      expect(cleanupJob).toMatchObject({
        bookId: book.id,
        kind: "purge_book",
        state: "queued",
      });
      if (!cleanupJob) throw new Error("Expected deletion cleanup job");
      expect(
        serializeJobStatus(cleanupJob, {
          kind: "book",
          label: "Delete me",
        }).kind,
      ).toBe("permanent_book_deletion");
      expect(database.prepare("SELECT * FROM book_deletions").all()).toEqual([
        expect.objectContaining({
          book_id: book.id,
          cleanup_job_id: result.jobId,
          id: result.deletionId,
          state: "pending",
        }),
      ]);
      const columns = Object.keys(
        database.prepare("SELECT * FROM book_deletions").get() as object,
      );
      expect(columns).not.toEqual(
        expect.arrayContaining(["title", "alias", "path", "filename"]),
      );
    });
  });

  it("replays the same accepted request but rejects mismatched or stale confirmation", async () => {
    await withMigratedTestDatabase(({ database }) => {
      const drafts = new DraftRepository(database);
      const book = drafts.createBook({ nowMs: 1_000, title: "Cafe\u0301" });
      const mutationToken = token(book);
      const first = acceptBookDeletion({
        actorUserId: "admin",
        bookId: book.id,
        confirmationTitle: "Café",
        database,
        idempotencyKey: "delete-book-request-0002",
        mutationToken,
        nowMs: 2_000,
      });
      expect(
        acceptBookDeletion({
          actorUserId: "admin",
          bookId: book.id,
          confirmationTitle: "Cafe\u0301",
          database,
          idempotencyKey: "delete-book-request-0002",
          mutationToken,
          nowMs: 3_000,
        }),
      ).toEqual(first);
      expect(() =>
        acceptBookDeletion({
          actorUserId: "admin",
          bookId: book.id,
          confirmationTitle: "Different",
          database,
          idempotencyKey: "delete-book-request-0002",
          mutationToken,
          nowMs: 3_000,
        }),
      ).toThrow(
        expect.objectContaining<Partial<SafeApplicationError>>({
          code: "IDEMPOTENCY_KEY_CONFLICT",
          status: 409,
        }),
      );
      expect(() =>
        acceptBookDeletion({
          actorUserId: "admin",
          bookId: book.id,
          confirmationTitle: "Café",
          database,
          idempotencyKey: "delete-book-request-0003",
          mutationToken,
          nowMs: 3_000,
        }),
      ).toThrow(
        expect.objectContaining<Partial<SafeApplicationError>>({
          code: "NOT_FOUND",
          status: 404,
        }),
      );
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM book_deletions").get(),
      ).toEqual({ count: 1 });
    });
  });

  it("creates no state when the title or mutation token is stale", async () => {
    await withMigratedTestDatabase(({ database }) => {
      const drafts = new DraftRepository(database);
      const book = drafts.createBook({ nowMs: 1_000, title: "Original" });
      for (const input of [
        { confirmationTitle: "original", mutationToken: token(book) },
        { confirmationTitle: "Original", mutationToken: `"${"x".repeat(43)}"` },
      ]) {
        expect(() =>
          acceptBookDeletion({
            actorUserId: "admin",
            bookId: book.id,
            database,
            idempotencyKey: `delete-stale-${input.mutationToken}`,
            nowMs: 2_000,
            ...input,
          }),
        ).toThrow(
          expect.objectContaining<Partial<SafeApplicationError>>({
            code: "DELETION_CONFIRMATION_STALE",
            status: 412,
          }),
        );
      }
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM book_deletions").get(),
      ).toEqual({ count: 0 });
      expect(drafts.requireBook(book.id).title).toBe("Original");
    });
  });

  it("cancels book-scoped queued work and requests termination of running work", async () => {
    await withMigratedTestDatabase(({ database }) => {
      const drafts = new DraftRepository(database);
      const book = drafts.createBook({ nowMs: 1_000, title: "Busy book" });
      const importId = "imp_busycancellation";
      database
        .prepare(
          `INSERT INTO imports (
            id, original_name, state, upload_rel_path, upload_size_bytes, upload_sha256,
            source_path, book_id, safe_error_code,
            created_at, updated_at, expires_at
          ) VALUES (?, 'fixture.zip', 'uploaded', ?, 3, ?, NULL, ?, NULL, 1000, 1000, 9000)`,
        )
        .run(
          importId,
          `tmp/uploads/${importId}/original.zip`,
          "a".repeat(64),
          book.id,
        );
      const jobs = new JobRepository(database);
      const indirect = jobs.create({
        bookId: book.id,
        importId,
        kind: "analyze_import",
        nowMs: 1_100,
      });
      expect(jobs.claimNext({ leaseOwner: "worker", nowMs: 1_200 })?.id).toBe(
        indirect.id,
      );

      const accepted = acceptBookDeletion({
        actorUserId: "admin",
        bookId: book.id,
        confirmationTitle: book.title,
        database,
        idempotencyKey: "delete-busy-book-0001",
        mutationToken: token(book),
        nowMs: 2_000,
      });
      expect(jobs.get(indirect.id)).toMatchObject({
        cancellationRequestedAtMs: 2_000,
        state: "running",
      });
      expect(jobs.get(accepted.jobId)).toMatchObject({
        state: "queued",
      });
      expect(
        jobs.claimNext({ leaseOwner: "another-worker", nowMs: 2_100 }),
      ).toBeNull();
    });
  });

  it("terminalizes a running candidate as canceled after the deletion barrier", async () => {
    await withMigratedTestDatabase(({ database }) => {
      const fixture = setupPublicationFixture(database, {
        registerReady: false,
      });
      const current = fixture.drafts.requireBook(fixture.book.id);
      acceptBookDeletion({
        actorUserId: "admin",
        bookId: current.id,
        confirmationTitle: current.title,
        database,
        idempotencyKey: "delete-running-candidate-0001",
        mutationToken: token(current),
        nowMs: 20,
      });

      expect(fixture.jobs.get(fixture.candidateJob.id)).toMatchObject({
        cancellationRequestedAtMs: 20,
        state: "running",
      });
      withImmediateTransaction(database, () => {
        fixture.jobs.completeFailure({
          errorClass: "canceled",
          errorCode: "JOB_CANCELED",
          jobId: fixture.candidateJob.id,
          leaseOwner: "worker:test",
          nowMs: 21,
        });
      });
      expect(fixture.candidates.require(fixture.build.id)).toMatchObject({
        safeErrorCode: "JOB_CANCELED",
        state: "canceled",
      });
    });
  });

  it("records an interrupted cleanup task and tombstone in one terminal outcome", async () => {
    await withMigratedTestDatabase(({ database }) => {
      const drafts = new DraftRepository(database);
      const book = drafts.createBook({ nowMs: 1_000, title: "Interrupted" });
      const accepted = acceptBookDeletion({
        actorUserId: "admin",
        bookId: book.id,
        confirmationTitle: book.title,
        database,
        idempotencyKey: "delete-interrupted-0001",
        mutationToken: token(book),
        nowMs: 2_000,
      });
      const jobs = new JobRepository(database);
      const claimed = jobs.claimNext({ leaseOwner: "worker", nowMs: 2_100 });
      if (!claimed) throw new Error("Expected cleanup job");
      markBookDeletionPurging(database, claimed.id, 2_100);

      completeBookDeletionInterruption({
        database,
        errorCode: "WORKER_SHUTDOWN",
        job: claimed,
        leaseOwner: "worker",
        nowMs: 2_200,
      });

      expect(jobs.get(accepted.jobId)).toMatchObject({ state: "interrupted" });
      expect(
        database
          .prepare(
            "SELECT state, safe_error_code FROM book_deletions WHERE id = ?",
          )
          .get(accepted.deletionId),
      ).toEqual({
        safe_error_code: "CLEANUP_INTERRUPTED",
        state: "failed",
      });
    });
  });

  it("prevents a ready candidate from publishing after deletion starts", async () => {
    await withMigratedTestDatabase(async ({ database }) => {
      const fixture = setupPublicationFixture(database);
      const current = fixture.drafts.requireBook(fixture.book.id);
      acceptBookDeletion({
        actorUserId: "admin",
        bookId: current.id,
        confirmationTitle: current.title,
        database,
        idempotencyKey: "delete-ready-candidate-0001",
        mutationToken: token(current),
        nowMs: 20,
      });

      await expect(
        publishReadyCandidateForTest({
          bookId: current.id,
          database,
          expectedUpdatedAt: fixture.document.updated_at,
          buildId: fixture.build.id,
          nowMs: 21,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
      expect(
        database
          .prepare(
            `SELECT current_version_id, deletion_requested_at
             FROM books WHERE id = ?`,
          )
          .get(current.id),
      ).toEqual({ current_version_id: null, deletion_requested_at: 20 });
    });
  });
});
