import type Database from "better-sqlite3";

import { isOpaqueId } from "@/domain/ids";
import type {
  BookDeletionTaskPort,
  BookPublishingRecordPurgePort,
  BookRemovalInventoryPort,
  BookRemovalInventory,
  BookWorkCancellationPort,
} from "@/modules/catalog/application/catalog-api";
import { JobRepository } from "./jobs";

const emptyProgress =
  '{"completed":0,"total":null,"unit":"steps","processed_bytes":null}';

export class SqliteBookPublishingCleanup
  implements
    BookDeletionTaskPort,
    BookPublishingRecordPurgePort,
    BookRemovalInventoryPort,
    BookWorkCancellationPort
{
  constructor(private readonly database: Database.Database) {}

  createPurgeTask(input: { readonly bookId: number; readonly nowMs: number }) {
    return new JobRepository(this.database).create({
      bookId: input.bookId,
      kind: "purge_book",
      nowMs: input.nowMs,
    });
  }

  cancelBookWork(input: {
    readonly bookId: number;
    readonly cleanupJobId: string;
    readonly nowMs: number;
  }): void {
    const parameters = {
      bookId: input.bookId,
      cleanupJobId: input.cleanupJobId,
      nowMs: input.nowMs,
    };
    this.database
      .prepare(
        `UPDATE jobs
         SET state = 'canceled', cancellation_requested_at = @nowMs,
             finished_at = @nowMs, error_class = 'canceled',
             error_code = 'JOB_CANCELED', phase = 'canceled',
             error_detail_json = NULL
         WHERE book_id = @bookId AND id != @cleanupJobId
           AND state = 'queued'`,
      )
      .run(parameters);
    this.database
      .prepare(
        `UPDATE jobs
         SET cancellation_requested_at = COALESCE(cancellation_requested_at, @nowMs)
         WHERE book_id = @bookId AND id != @cleanupJobId
           AND state = 'running'`,
      )
      .run(parameters);
  }

  captureRemovalInventory(bookId: number): BookRemovalInventory {
    const importIds = (
      this.database
        .prepare("SELECT id FROM imports WHERE book_id = ? ORDER BY id")
        .all(bookId) as { id: string }[]
    ).map((row) => row.id);
    const jobIds = (
      this.database
        .prepare("SELECT id FROM jobs WHERE book_id = ? ORDER BY id")
        .all(bookId) as { id: string }[]
    ).map((row) => row.id);
    if (
      importIds.some((id) => !isOpaqueId("import", id)) ||
      jobIds.some((id) => !isOpaqueId("job", id))
    ) {
      throw new Error("CLEANUP_DATABASE_INTEGRITY");
    }
    return Object.freeze({
      importIds: Object.freeze(importIds),
      jobIds: Object.freeze(jobIds),
    });
  }

  purgeBookRecords(input: {
    readonly bookId: number;
    readonly cleanupJobId: string;
  }): void {
    const importIds = (
      this.database
        .prepare("SELECT id FROM imports WHERE book_id = ? ORDER BY id")
        .all(input.bookId) as { id: string }[]
    ).map((row) => row.id);
    const placeholders = importIds.map(() => "?").join(", ");
    this.database
      .prepare(
        `DELETE FROM audit_events
         WHERE book_id = @bookId
            OR version_id IN (SELECT id FROM book_versions WHERE book_id = @bookId)
            OR job_id IN (SELECT id FROM jobs WHERE book_id = @bookId)`,
      )
      .run({ bookId: input.bookId });
    this.database
      .prepare("DELETE FROM search_fts WHERE book_id = ?")
      .run(input.bookId);
    this.database
      .prepare("DELETE FROM search_short_fields WHERE book_id = ?")
      .run(input.bookId);
    this.database
      .prepare(
        `UPDATE jobs
         SET import_id = NULL, book_id = NULL,
             version_id = NULL, captured_input_path = NULL,
             captured_source_updated_at = NULL,
             captured_current_version_id = NULL, progress_json = ?,
             error_detail_json = NULL,
             error_code = CASE
               WHEN id != ? AND state != 'succeeded' THEN 'JOB_SUBJECT_DELETED'
               ELSE error_code
             END
         WHERE book_id = ?`,
      )
      .run(emptyProgress, input.cleanupJobId, input.bookId);
    this.database
      .prepare("DELETE FROM book_documents WHERE book_id=?")
      .run(input.bookId);
    this.database
      .prepare("DELETE FROM document_commands WHERE book_id=?")
      .run(input.bookId);
    this.database
      .prepare(
        "UPDATE book_versions SET predecessor_version_id = NULL WHERE book_id = ?",
      )
      .run(input.bookId);
    this.database
      .prepare("DELETE FROM book_versions WHERE book_id = ?")
      .run(input.bookId);
    this.database
      .prepare("DELETE FROM original_files WHERE book_id = ?")
      .run(input.bookId);
    this.database
      .prepare("DELETE FROM book_resources WHERE book_id = ?")
      .run(input.bookId);
    if (importIds.length > 0) {
      this.database
        .prepare(`DELETE FROM imports WHERE id IN (${placeholders})`)
        .run(...importIds);
    }
  }
}
