import type Database from "better-sqlite3";
import { SafeApplicationError } from "@/domain/errors";

export class ResourceRepository {
  private available?: Database.Statement;
  private rootDelete?: Database.Statement;
  private rootInsert?: Database.Statement;
  private clearUnused?: Database.Statement;
  private versionInsert?: Database.Statement;
  constructor(private readonly database: Database.Database) {}

  requireAvailable(bookId: number, ids: readonly string[]): void {
    if (ids.length === 0) return;
    const find = (this.available ??= this.database.prepare(
      "SELECT 1 FROM book_resources WHERE book_id=? AND id=? AND deletion_requested_at IS NULL",
    ));
    for (const id of new Set(ids)) {
      if (!find.get(bookId, id))
        throw new SafeApplicationError(
          "BOOK_RESOURCE_MISSING",
          "The resource is no longer available.",
          409,
        );
    }
  }

  replaceRoot(bookId: number, rootId: string, ids: readonly string[]): void {
    this.requireAvailable(bookId, ids);
    (this.rootDelete ??= this.database.prepare(
      "DELETE FROM book_block_resources WHERE book_id=? AND root_id=?",
    )).run(bookId, rootId);
    if (ids.length === 0) return;
    const insert = (this.rootInsert ??= this.database.prepare(
      "INSERT INTO book_block_resources(book_id,root_id,resource_id) VALUES (?,?,?)",
    ));
    for (const id of ids) insert.run(bookId, rootId, id);
    this.touch(bookId, ids);
  }

  touch(bookId: number, ids: readonly string[]): void {
    if (ids.length === 0) return;
    const update = (this.clearUnused ??= this.database.prepare(
      "UPDATE book_resources SET unreferenced_at=NULL WHERE book_id=? AND id=? AND unreferenced_at IS NOT NULL",
    ));
    for (const id of ids) update.run(bookId, id);
  }

  registerVersion(
    bookId: number,
    versionId: string,
    ids: readonly string[],
  ): void {
    if (ids.length === 0) return;
    this.requireAvailable(bookId, ids);
    const insert = (this.versionInsert ??= this.database.prepare(
      "INSERT INTO book_version_resources(book_id,version_id,resource_id) VALUES (?,?,?)",
    ));
    for (const id of ids) insert.run(bookId, versionId, id);
    this.touch(bookId, ids);
  }

  listImages(bookId: number, resourceId?: string) {
    return this.database
      .prepare(
        `SELECT resource.id AS resource_id, resource.storage_rel_path,
      resource.media_type, resource.size_bytes, resource.width, resource.height,
      resource.id IS json_extract(document.metadata_json,'$.cover_resource_id') AS selected
      FROM book_resources resource JOIN books ON books.id=resource.book_id
      JOIN book_documents document ON document.book_id=books.id
      WHERE resource.book_id=@bookId AND books.deletion_requested_at IS NULL
        AND resource.deletion_requested_at IS NULL
        AND resource.width IS NOT NULL AND resource.height IS NOT NULL
        ${resourceId ? "AND resource.id=@resourceId" : ""}
      ORDER BY resource.created_at,resource.id`,
      )
      .all({ bookId, ...(resourceId ? { resourceId } : {}) }) as {
      resource_id: string;
      storage_rel_path: string;
      media_type: string;
      size_bytes: number;
      width: number;
      height: number;
      selected: number;
    }[];
  }
}
