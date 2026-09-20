import type Database from "better-sqlite3";

import { isDeletionSafeErrorCode } from "@/domain/book-deletion";
import { BookDeletionRepository } from "@/modules/catalog/adapters/sqlite/book-deletions";
import { SqliteBookPublishingCleanup } from "@/modules/publishing/adapters/sqlite/book-cleanup";
import {
  JobRepository,
  type JobRecord,
} from "@/modules/publishing/adapters/sqlite/jobs";
import type { JobErrorClass } from "@/modules/publishing/application/publishing-api";
import { withImmediateTransaction } from "@/platform/sqlite/immediate-transaction";

function deletionErrorCode(errorClass: JobErrorClass, errorCode: string) {
  if (isDeletionSafeErrorCode(errorCode)) return errorCode;
  if (errorClass === "timeout") return "CLEANUP_TIMEOUT" as const;
  if (errorClass === "infrastructure" || errorClass === "canceled") {
    return "CLEANUP_INTERRUPTED" as const;
  }
  return "CLEANUP_FILESYSTEM_IO" as const;
}

export function markBookDeletionPurging(
  database: Database.Database,
  jobId: string,
  nowMs: number,
): void {
  new BookDeletionRepository(database).markPurging(jobId, nowMs);
}

export function recordExpiredBookDeletion(
  database: Database.Database,
  job: JobRecord,
  nowMs: number,
): void {
  if (job.kind !== "purge_book") return;
  new BookDeletionRepository(database).markFailed(
    job.id,
    "CLEANUP_INTERRUPTED",
    nowMs,
  );
}

export function cancelBookDeletion(
  database: Database.Database,
  job: JobRecord,
  nowMs: number,
): JobRecord {
  return withImmediateTransaction(database, () => {
    const canceled = new JobRepository(database).requestCancellation(
      job.id,
      nowMs,
    );
    if (canceled.state === "canceled") {
      new BookDeletionRepository(database).markFailed(
        job.id,
        "CLEANUP_INTERRUPTED",
        nowMs,
      );
    }
    return canceled;
  });
}

export function completeBookDeletionFailure(input: {
  readonly database: Database.Database;
  readonly errorClass: JobErrorClass;
  readonly errorCode: string;
  readonly job: JobRecord;
  readonly leaseOwner: string;
  readonly nowMs: number;
}): JobRecord {
  return withImmediateTransaction(input.database, () => {
    const completed = new JobRepository(input.database).completeFailure({
      errorClass: input.errorClass,
      errorCode: input.errorCode,
      jobId: input.job.id,
      leaseOwner: input.leaseOwner,
      nowMs: input.nowMs,
    });
    new BookDeletionRepository(input.database).markFailed(
      input.job.id,
      deletionErrorCode(input.errorClass, input.errorCode),
      input.nowMs,
    );
    return completed;
  });
}

export function completeBookDeletionInterruption(input: {
  readonly database: Database.Database;
  readonly errorCode: string;
  readonly job: JobRecord;
  readonly leaseOwner: string;
  readonly nowMs: number;
}): JobRecord {
  return withImmediateTransaction(input.database, () => {
    const completed = new JobRepository(input.database).completeInterruption({
      errorCode: input.errorCode,
      jobId: input.job.id,
      leaseOwner: input.leaseOwner,
      nowMs: input.nowMs,
    });
    new BookDeletionRepository(input.database).markFailed(
      input.job.id,
      "CLEANUP_INTERRUPTED",
      input.nowMs,
    );
    return completed;
  });
}

export function failQueuedBookDeletion(input: {
  readonly database: Database.Database;
  readonly errorClass: JobErrorClass;
  readonly errorCode: string;
  readonly jobId: string;
  readonly nowMs: number;
}): JobRecord {
  return withImmediateTransaction(input.database, () => {
    const failed = new JobRepository(input.database).fail(input.jobId, {
      errorClass: input.errorClass,
      errorCode: input.errorCode,
      nowMs: input.nowMs,
    });
    new BookDeletionRepository(input.database).markFailed(
      input.jobId,
      deletionErrorCode(input.errorClass, input.errorCode),
      input.nowMs,
    );
    return failed;
  });
}

export function retryBookDeletion(input: {
  readonly automatic: boolean;
  readonly database: Database.Database;
  readonly idempotency?: {
    readonly key: string;
    readonly operation: string;
  };
  readonly jobId: string;
  readonly nowMs: number;
}): JobRecord {
  return withImmediateTransaction(input.database, () => {
    const jobs = new JobRepository(input.database);
    const original = jobs.get(input.jobId);
    if (
      !original ||
      original.kind !== "purge_book" ||
      original.bookId === null
    ) {
      throw new Error("CLEANUP_INVALID_STATE");
    }
    const retry = jobs.retry(input.jobId, {
      automatic: input.automatic,
      ...(input.idempotency ? { idempotency: input.idempotency } : {}),
      nowMs: input.nowMs,
    });
    new BookDeletionRepository(input.database).assignRetry({
      bookId: original.bookId,
      nextJobId: retry.id,
      nowMs: input.nowMs,
      previousJobId: original.id,
    });
    return retry;
  });
}

export function finalizeBookDeletion(input: {
  readonly bookId: number;
  readonly database: Database.Database;
  readonly jobId: string;
  readonly leaseOwner: string;
  readonly nowMs: number;
}): JobRecord {
  return withImmediateTransaction(input.database, () => {
    const deletions = new BookDeletionRepository(input.database);
    deletions.clearBookPointers(input.bookId);
    new SqliteBookPublishingCleanup(input.database).purgeBookRecords({
      bookId: input.bookId,
      cleanupJobId: input.jobId,
    });
    deletions.completeBookRemoval({
      bookId: input.bookId,
      cleanupJobId: input.jobId,
      nowMs: input.nowMs,
    });
    const completed = new JobRepository(input.database).completeSuccess({
      jobId: input.jobId,
      leaseOwner: input.leaseOwner,
      nowMs: input.nowMs,
    });
    if ((input.database.pragma("foreign_key_check") as unknown[]).length > 0) {
      throw new Error("CLEANUP_DATABASE_INTEGRITY");
    }
    return completed;
  });
}
