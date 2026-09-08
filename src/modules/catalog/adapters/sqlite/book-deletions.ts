import type Database from "better-sqlite3";

import {
  isDeletionSafeErrorCode,
  type BookDeletionState,
  type DeletionSafeErrorCode,
} from "@/domain/book-deletion";

interface DeletionRow {
  book_id: number;
  cleanup_job_id: string;
  completed_at: number | null;
  id: string;
  idempotency_key_hash: string;
  request_fingerprint: string;
  requested_at: number;
  requested_by_user_id: string;
  safe_error_code: string | null;
  started_at: number | null;
  state: BookDeletionState;
  updated_at: number;
}

export interface BookDeletionRecord {
  readonly bookId: number;
  readonly cleanupJobId: string;
  readonly completedAtMs: number | null;
  readonly id: string;
  readonly idempotencyKeyHash: string;
  readonly requestFingerprint: string;
  readonly requestedAtMs: number;
  readonly requestedByUserId: string;
  readonly safeErrorCode: DeletionSafeErrorCode | null;
  readonly startedAtMs: number | null;
  readonly state: BookDeletionState;
  readonly updatedAtMs: number;
}

function mapDeletion(row: DeletionRow): BookDeletionRecord {
  if (row.safe_error_code && !isDeletionSafeErrorCode(row.safe_error_code)) {
    throw new Error("DELETION_SAFE_ERROR_CODE_INVALID");
  }
  return Object.freeze({
    bookId: row.book_id,
    cleanupJobId: row.cleanup_job_id,
    completedAtMs: row.completed_at,
    id: row.id,
    idempotencyKeyHash: row.idempotency_key_hash,
    requestFingerprint: row.request_fingerprint,
    requestedAtMs: row.requested_at,
    requestedByUserId: row.requested_by_user_id,
    safeErrorCode: row.safe_error_code as DeletionSafeErrorCode | null,
    startedAtMs: row.started_at,
    state: row.state,
    updatedAtMs: row.updated_at,
  });
}

export class BookDeletionRepository {
  constructor(private readonly database: Database.Database) {}

  findByBookId(bookId: number): BookDeletionRecord | null {
    const row = this.database
      .prepare("SELECT * FROM book_deletions WHERE book_id = ?")
      .get(bookId) as DeletionRow | undefined;
    return row ? mapDeletion(row) : null;
  }

  findById(id: string): BookDeletionRecord | null {
    const row = this.database
      .prepare("SELECT * FROM book_deletions WHERE id = ?")
      .get(id) as DeletionRow | undefined;
    return row ? mapDeletion(row) : null;
  }

  findByIdempotencyHash(hash: string): BookDeletionRecord | null {
    const row = this.database
      .prepare("SELECT * FROM book_deletions WHERE idempotency_key_hash = ?")
      .get(hash) as DeletionRow | undefined;
    return row ? mapDeletion(row) : null;
  }

  requireByCleanupJobId(jobId: string): BookDeletionRecord {
    const row = this.database
      .prepare("SELECT * FROM book_deletions WHERE cleanup_job_id = ?")
      .get(jobId) as DeletionRow | undefined;
    if (!row) throw new Error("CLEANUP_INVALID_STATE");
    return mapDeletion(row);
  }

  markPurging(jobId: string, nowMs: number): BookDeletionRecord {
    const changed = this.database
      .prepare(
        `UPDATE book_deletions
         SET state = 'purging', started_at = COALESCE(started_at, ?),
             safe_error_code = NULL, updated_at = ?
         WHERE cleanup_job_id = ? AND state IN ('pending', 'failed', 'purging')`,
      )
      .run(nowMs, nowMs, jobId);
    if (changed.changes !== 1) throw new Error("CLEANUP_INVALID_STATE");
    return this.requireByCleanupJobId(jobId);
  }

  markFailed(
    jobId: string,
    safeErrorCode: DeletionSafeErrorCode,
    nowMs: number,
  ): BookDeletionRecord {
    const changed = this.database
      .prepare(
        `UPDATE book_deletions
         SET state = 'failed', safe_error_code = ?, updated_at = ?
         WHERE cleanup_job_id = ? AND state != 'completed'`,
      )
      .run(safeErrorCode, nowMs, jobId);
    if (changed.changes !== 1) throw new Error("CLEANUP_INVALID_STATE");
    return this.requireByCleanupJobId(jobId);
  }

  assignRetry(input: {
    readonly bookId: number;
    readonly nextJobId: string;
    readonly nowMs: number;
    readonly previousJobId: string;
  }): BookDeletionRecord {
    const changed = this.database
      .prepare(
        `UPDATE book_deletions
         SET cleanup_job_id = ?, state = 'pending', safe_error_code = NULL,
             completed_at = NULL, updated_at = ?
         WHERE cleanup_job_id = ? AND book_id = ? AND state = 'failed'`,
      )
      .run(input.nextJobId, input.nowMs, input.previousJobId, input.bookId);
    if (changed.changes !== 1) throw new Error("CLEANUP_INVALID_STATE");
    return this.requireByCleanupJobId(input.nextJobId);
  }

  clearBookPointers(bookId: number): void {
    const cleared = this.database
      .prepare(
        `UPDATE books
         SET draft_import_id = NULL,
             current_version_id = NULL
         WHERE id = ? AND deletion_requested_at IS NOT NULL`,
      )
      .run(bookId);
    if (cleared.changes !== 1) throw new Error("CLEANUP_DATABASE_CONFLICT");
  }

  completeBookRemoval(input: {
    readonly bookId: number;
    readonly cleanupJobId: string;
    readonly nowMs: number;
  }): BookDeletionRecord {
    const deletion = this.requireByCleanupJobId(input.cleanupJobId);
    if (deletion.state === "completed") return deletion;
    if (deletion.bookId !== input.bookId) {
      throw new Error("CLEANUP_DATABASE_CONFLICT");
    }
    this.database
      .prepare("DELETE FROM book_version_presentations WHERE book_id = ?")
      .run(input.bookId);
    const removed = this.database
      .prepare(
        "DELETE FROM books WHERE id = ? AND deletion_requested_at IS NOT NULL",
      )
      .run(input.bookId);
    if (removed.changes !== 1) throw new Error("CLEANUP_DATABASE_CONFLICT");
    const completed = this.database
      .prepare(
        `UPDATE book_deletions
         SET state = 'completed', safe_error_code = NULL,
             completed_at = ?, updated_at = ?
         WHERE cleanup_job_id = ? AND state != 'completed'`,
      )
      .run(input.nowMs, input.nowMs, input.cleanupJobId);
    if (completed.changes !== 1) throw new Error("CLEANUP_DATABASE_CONFLICT");
    return this.requireByCleanupJobId(input.cleanupJobId);
  }
}
