import type Database from "better-sqlite3";

export type BookAccess = "private" | "public";
export interface BookRecord {
  readonly access: BookAccess;
  readonly alias: string | null;
  readonly createdAtMs: number;
  readonly currentVersionId: string | null;
  readonly draftImportId: string | null;
  readonly id: number;
  readonly title: string;
  readonly unavailableReason: string | null;
  readonly updatedAtMs: number;
}
interface BookRow {
  access: BookAccess;
  alias: string | null;
  created_at: number;
  current_version_id: string | null;
  draft_import_id: string | null;
  id: number;
  title_cache: string;
  unavailable_reason: string | null;
  updated_at: number;
}
export class DraftRepository {
  constructor(private readonly database: Database.Database) {}
  createBook(input: {
    readonly nowMs: number;
    readonly title: string;
  }): BookRecord {
    const result = this.database
      .prepare(
        "INSERT INTO books (access,title_cache,created_at,updated_at) VALUES ('private',?,?,?)",
      )
      .run(input.title, input.nowMs, input.nowMs);
    return this.requireBook(Number(result.lastInsertRowid));
  }
  findBook(bookId: number): BookRecord | null {
    const row = this.database
      .prepare(
        "SELECT * FROM books WHERE id = ? AND deletion_requested_at IS NULL",
      )
      .get(bookId) as BookRow | undefined;
    return row
      ? {
          access: row.access,
          alias: row.alias,
          createdAtMs: row.created_at,
          currentVersionId: row.current_version_id,
          draftImportId: row.draft_import_id,
          id: row.id,
          title: row.title_cache,
          unavailableReason: row.unavailable_reason,
          updatedAtMs: row.updated_at,
        }
      : null;
  }
  requireBook(bookId: number): BookRecord {
    const book = this.findBook(bookId);
    if (!book) throw new Error("BOOK_NOT_FOUND");
    return book;
  }
}
