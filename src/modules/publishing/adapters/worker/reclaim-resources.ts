import type Database from "better-sqlite3";
import { resolve } from "node:path";
import { withImmediateTransaction } from "@/platform/sqlite/immediate-transaction";
import type { StorageLayout } from "@/platform/filesystem/storage-layout";

export const resourceRetentionGraceMs = 60 * 60 * 1_000;
export const reclamationBatchSize = 32;

const unused = `NOT EXISTS (SELECT 1 FROM book_block_resources reference
    WHERE reference.book_id=resource.book_id AND reference.resource_id=resource.id)
  AND NOT EXISTS (SELECT 1 FROM book_documents document WHERE document.book_id=resource.book_id
    AND json_extract(document.metadata_json,'$.cover_resource_id')=resource.id)
  AND NOT EXISTS (SELECT 1 FROM book_version_resources reference
    WHERE reference.book_id=resource.book_id AND reference.resource_id=resource.id)
  AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.book_id=resource.book_id AND jobs.state='running')`;

export async function reclaimResources(input: {
  database: Database.Database;
  layout: StorageLayout;
  nowMs: number;
  removePath: (path: string) => Promise<void>;
}): Promise<string[]> {
  const database = input.database;
  const pending = withImmediateTransaction(database, () => {
    database
      .prepare(
        `UPDATE book_resources AS resource
      SET unreferenced_at=CASE WHEN ${unused} THEN COALESCE(unreferenced_at,@now) ELSE NULL END
      WHERE retention='referenced' AND deletion_requested_at IS NULL
      AND EXISTS (SELECT 1 FROM books WHERE books.id=resource.book_id AND books.deletion_requested_at IS NULL)`,
      )
      .run({ now: input.nowMs });
    const rows = database
      .prepare(
        `SELECT id,storage_rel_path FROM book_resources AS resource
      WHERE retention='referenced'
        AND EXISTS (SELECT 1 FROM books WHERE books.id=resource.book_id AND books.deletion_requested_at IS NULL)
        AND (deletion_requested_at IS NOT NULL OR (unreferenced_at<=@cutoff AND ${unused}))
      ORDER BY COALESCE(cleanup_attempted_at,0),created_at,id LIMIT @limit`,
      )
      .all({
        cutoff: input.nowMs - resourceRetentionGraceMs,
        limit: reclamationBatchSize,
      }) as { id: string; storage_rel_path: string }[];
    const mark = database.prepare(`UPDATE book_resources SET
      deletion_requested_at=COALESCE(deletion_requested_at,?),cleanup_attempted_at=? WHERE id=?`);
    for (const row of rows) mark.run(input.nowMs, input.nowMs, row.id);
    return rows;
  });
  const failed: string[] = [];
  for (const row of pending) {
    try {
      await input.removePath(resolve(input.layout.root, row.storage_rel_path));
      database
        .prepare(
          "DELETE FROM book_resources WHERE id=? AND deletion_requested_at IS NOT NULL",
        )
        .run(row.id);
    } catch {
      failed.push(row.storage_rel_path);
    }
  }
  return failed;
}
