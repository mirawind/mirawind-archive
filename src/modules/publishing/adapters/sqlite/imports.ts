import type Database from "better-sqlite3";

import { hasControlCharacters } from "@/domain/text";
import { createOpaqueId } from "@/domain/ids";
import { withImmediateTransaction } from "@/platform/sqlite/immediate-transaction";

export type ImportState =
  | "uploaded"
  | "analyzing"
  | "preparing"
  | "draft_ready"
  | "rejected"
  | "canceled"
  | "expired";

interface ImportRow {
  book_id: number | null;
  created_at: number;
  expires_at: number;
  id: string;
  original_name: string;
  safe_error_code: string | null;
  source_path: string | null;
  state: ImportState;
  updated_at: number;
  upload_rel_path: string;
  upload_sha256: string;
  upload_size_bytes: number;
}

export interface ImportRecord {
  readonly bookId: number | null;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly id: string;
  readonly originalName: string;
  readonly safeErrorCode: string | null;
  readonly sourcePath: string | null;
  readonly state: ImportState;
  readonly updatedAtMs: number;
  readonly uploadRelativePath: string;
  readonly uploadSha256: string;
  readonly uploadSizeBytes: number;
}

function mapImport(row: ImportRow): ImportRecord {
  return Object.freeze({
    bookId: row.book_id,
    createdAtMs: row.created_at,
    expiresAtMs: row.expires_at,
    id: row.id,
    originalName: row.original_name,
    safeErrorCode: row.safe_error_code,
    sourcePath: row.source_path,
    state: row.state,
    updatedAtMs: row.updated_at,
    uploadRelativePath: row.upload_rel_path,
    uploadSha256: row.upload_sha256,
    uploadSizeBytes: row.upload_size_bytes,
  });
}

function validateSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("SHA256_INVALID");
}

function validateSafeErrorCode(value: string): void {
  if (!/^[A-Z][A-Z0-9_]{2,79}$/u.test(value)) {
    throw new Error("IMPORT_ERROR_CODE_INVALID");
  }
}

export class ImportRepository {
  constructor(private readonly database: Database.Database) {}

  createUploaded(input: {
    readonly bookId?: number;
    readonly expiresAtMs: number;
    readonly id?: string;
    readonly nowMs: number;
    readonly originalName: string;
    readonly uploadRelativePath: string;
    readonly uploadSha256: string;
    readonly uploadSizeBytes: number;
  }): ImportRecord {
    validateSha256(input.uploadSha256);
    if (
      [...input.originalName].length < 1 ||
      [...input.originalName].length > 255 ||
      hasControlCharacters(input.originalName)
    ) {
      throw new Error("IMPORT_ORIGINAL_NAME_INVALID");
    }
    const id = input.id ?? createOpaqueId("import");
    this.database
      .prepare(
        `INSERT INTO imports (
          id, original_name, state, upload_rel_path, upload_size_bytes, upload_sha256,
          source_path, book_id, safe_error_code,
          created_at, updated_at, expires_at
        ) VALUES (?, ?, 'uploaded', ?, ?, ?, NULL, ?, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        input.originalName,
        input.uploadRelativePath,
        input.uploadSizeBytes,
        input.uploadSha256,
        input.bookId ?? null,
        input.nowMs,
        input.nowMs,
        input.expiresAtMs,
      );
    return this.require(id);
  }

  find(id: string): ImportRecord | null {
    const row = this.database
      .prepare("SELECT * FROM imports WHERE id = ?")
      .get(id) as ImportRow | undefined;
    return row ? mapImport(row) : null;
  }

  require(id: string): ImportRecord {
    const record = this.find(id);
    if (!record) throw new Error("IMPORT_NOT_FOUND");
    return record;
  }

  startAnalysis(importId: string, nowMs: number): ImportRecord {
    const current = this.require(importId);
    if (current.state === "analyzing") return current;
    this.transition(importId, "uploaded", "analyzing", nowMs);
    return this.require(importId);
  }

  selectDocument(input: {
    importId: string;
    path: string;
    nowMs: number;
  }): ImportRecord {
    if (
      !/(?:^|_)content_list_v2\.json$/iu.test(
        input.path.split("/").at(-1) ?? "",
      ) ||
      input.path
        .split("/")
        .some((part) => !part || part === "." || part === "..")
    )
      throw new Error("IMPORT_DOCUMENT_INVALID");
    const changed = this.database
      .prepare(
        "UPDATE imports SET state='preparing',source_path=?,updated_at=? WHERE id=? AND state='analyzing'",
      )
      .run(input.path, input.nowMs, input.importId);
    if (changed.changes !== 1) throw new Error("IMPORT_STATE_CONFLICT");
    return this.require(input.importId);
  }

  attachBookForPreparation(input: {
    readonly bookId: number;
    readonly importId: string;
    readonly nowMs: number;
  }): ImportRecord {
    return withImmediateTransaction(this.database, () => {
      const result = this.database
        .prepare(
          `UPDATE imports
           SET book_id = ?, updated_at = ?
           WHERE id = ? AND state = 'preparing'
             AND (book_id IS NULL OR book_id = ?)`,
        )
        .run(input.bookId, input.nowMs, input.importId, input.bookId);
      if (result.changes !== 1) throw new Error("IMPORT_STATE_CONFLICT");
      this.scopeJobsToBook(input.importId, input.bookId);
      return this.require(input.importId);
    });
  }

  attachPreparedBook(input: {
    readonly bookId: number;
    readonly importId: string;
    readonly nowMs: number;
  }): ImportRecord {
    return withImmediateTransaction(this.database, () => {
      const result = this.database
        .prepare(
          `UPDATE imports
           SET state = 'draft_ready', book_id = ?, updated_at = ?
           WHERE id = ? AND state = 'preparing'
             AND (book_id IS NULL OR book_id = ?)`,
        )
        .run(input.bookId, input.nowMs, input.importId, input.bookId);
      if (result.changes !== 1) throw new Error("IMPORT_STATE_CONFLICT");
      this.scopeJobsToBook(input.importId, input.bookId);
      return this.require(input.importId);
    });
  }

  private scopeJobsToBook(importId: string, bookId: number): void {
    const conflict = this.database
      .prepare(
        `SELECT 1 FROM jobs
         WHERE import_id = ? AND book_id IS NOT NULL AND book_id != ?
         LIMIT 1`,
      )
      .get(importId, bookId);
    if (conflict) throw new Error("IMPORT_BOOK_SCOPE_CONFLICT");
    this.database
      .prepare(
        "UPDATE jobs SET book_id = ? WHERE import_id = ? AND book_id IS NULL",
      )
      .run(bookId, importId);
  }

  reject(importId: string, errorCode: string, nowMs: number): ImportRecord {
    validateSafeErrorCode(errorCode);
    const result = this.database
      .prepare(
        `UPDATE imports
         SET state = 'rejected', safe_error_code = ?, updated_at = ?
         WHERE id = ? AND state IN (
           'uploaded', 'analyzing', 'preparing'
         )`,
      )
      .run(errorCode, nowMs, importId);
    if (result.changes !== 1) throw new Error("IMPORT_STATE_CONFLICT");
    return this.require(importId);
  }

  cancel(importId: string, nowMs: number): ImportRecord {
    const result = this.database
      .prepare(
        `UPDATE imports
         SET state = 'canceled', updated_at = ?
         WHERE id = ? AND state IN (
           'uploaded', 'analyzing', 'preparing'
         )`,
      )
      .run(nowMs, importId);
    if (result.changes !== 1) throw new Error("IMPORT_STATE_CONFLICT");
    return this.require(importId);
  }

  private transition(
    importId: string,
    from: ImportState,
    to: ImportState,
    nowMs: number,
  ): void {
    const result = this.database
      .prepare(
        "UPDATE imports SET state = ?, updated_at = ? WHERE id = ? AND state = ?",
      )
      .run(to, nowMs, importId, from);
    if (result.changes !== 1) throw new Error("IMPORT_STATE_CONFLICT");
  }
}
