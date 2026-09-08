import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import type Database from "better-sqlite3";

import type { BookVersionPresentationRemover } from "@/modules/catalog/application/catalog-api";
import { VersionRepository } from "../sqlite/versions";
import type { StorageLayout } from "@/platform/filesystem/storage-layout";
import { removeExactContainedTree } from "@/platform/filesystem/permanent-removal";

export const versionRetentionGraceMs = 24 * 60 * 60 * 1_000;
export const previewRetentionGraceMs = 60 * 60 * 1_000;

export interface ReclamationResult {
  readonly failedPaths: readonly string[];
  readonly reclaimedVersionIds: readonly string[];
  readonly removedQuarantinePaths: readonly string[];
}

type RemovePath = (path: string) => Promise<void>;

async function reclaimQuarantine(input: {
  readonly cutoffMs: number;
  readonly layout: StorageLayout;
  readonly removePath: RemovePath;
}): Promise<{
  readonly failed: string[];
  readonly removed: string[];
}> {
  const failed: string[] = [];
  const removed: string[] = [];
  const books = await readdir(input.layout.bookDirectory, {
    withFileTypes: true,
  });
  for (const book of books) {
    if (
      !book.isDirectory() ||
      book.isSymbolicLink() ||
      !/^[1-9][0-9]*$/u.test(book.name)
    ) {
      continue;
    }
    const directory = resolve(
      input.layout.bookDirectory,
      book.name,
      "quarantine",
    );
    const directoryMetadata = await lstat(directory).catch((error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    });
    if (!directoryMetadata) continue;
    if (
      !directoryMetadata.isDirectory() ||
      directoryMetadata.isSymbolicLink()
    ) {
      throw new Error("QUARANTINE_DIRECTORY_UNSAFE");
    }
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: unknown) => {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return [];
        }
        throw error;
      },
    );
    for (const entry of entries) {
      const match = /\.([0-9]+)$/u.exec(entry.name);
      const quarantinedAtMs = match ? Number(match[1]) : Number.NaN;
      if (
        !Number.isSafeInteger(quarantinedAtMs) ||
        quarantinedAtMs > input.cutoffMs
      ) {
        continue;
      }
      const relativePath = `books/${book.name}/quarantine/${entry.name}`;
      try {
        await input.removePath(resolve(directory, entry.name));
        removed.push(relativePath);
      } catch {
        failed.push(relativePath);
      }
    }
  }
  return { failed, removed };
}

export async function reclaimRetainedStorage(input: {
  readonly database: Database.Database;
  readonly layout: StorageLayout;
  readonly nowMs: number;
  readonly presentationRemover: BookVersionPresentationRemover;
  readonly removePath?: RemovePath;
}): Promise<ReclamationResult> {
  const removePath =
    input.removePath ??
    ((target: string) =>
      removeExactContainedTree({ root: input.layout.root, target }));
  const cutoffMs = input.nowMs - versionRetentionGraceMs;
  const candidates = input.database
    .prepare(
      `SELECT versions.id
       FROM book_versions AS versions
       JOIN books ON books.id = versions.book_id
       WHERE ((versions.state = 'superseded'
         AND versions.verified_at IS NOT NULL
         AND versions.published_at IS NOT NULL
         AND versions.published_at <= @publishedCutoff)
         OR (versions.state = 'discarded' AND versions.complete_at <= @previewCutoff))
         AND books.deletion_requested_at IS NULL
         AND versions.reclaimed_at IS NULL
         AND versions.id IS NOT books.current_version_id
         AND versions.id <> COALESCE((
           SELECT previous.id
           FROM book_versions AS previous
           WHERE previous.book_id = versions.book_id
             AND previous.state = 'superseded'
             AND previous.reclaimed_at IS NULL
             AND previous.verified_at IS NOT NULL
             AND previous.published_at IS NOT NULL
           ORDER BY previous.published_at DESC, previous.id DESC
           LIMIT 1
         ), '')
       ORDER BY versions.book_id, versions.published_at, versions.id`,
    )
    .all({
      publishedCutoff: cutoffMs,
      previewCutoff: input.nowMs - previewRetentionGraceMs,
    }) as { id: string }[];
  const failedPaths: string[] = [];
  const reclaimedVersionIds: string[] = [];
  const versions = new VersionRepository(input.database);

  const tombstone = input.database.transaction((versionId: string) => {
    const version = versions.require(versionId);
    const changed = input.database
      .prepare(
        `UPDATE book_versions SET reclaimed_at = ?
         WHERE id = ? AND state IN ('superseded','discarded') AND reclaimed_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM books WHERE current_version_id=book_versions.id)`,
      )
      .run(input.nowMs, versionId);
    if (changed.changes !== 1) throw new Error("VERSION_RECLAIM_RACE");
    input.database
      .prepare("DELETE FROM search_short_fields WHERE version_id = ?")
      .run(versionId);
    input.database
      .prepare("DELETE FROM search_fts WHERE version_id = ?")
      .run(versionId);
    input.presentationRemover.delete(versionId);
    input.database
      .prepare(
        `INSERT INTO audit_events (
           actor_user_id, action, book_id, version_id, job_id,
           safe_metadata_json, created_at
         ) VALUES (NULL, 'book.version.reclaimed', ?, ?, NULL, '{}', ?)`,
      )
      .run(version.bookId, versionId, input.nowMs);
    return version.versionRelativePath;
  });

  for (const candidate of candidates) {
    const relativePath = tombstone.immediate(candidate.id);
    reclaimedVersionIds.push(candidate.id);
    try {
      await removePath(resolve(input.layout.root, relativePath));
    } catch {
      failedPaths.push(relativePath);
    }
  }

  for (const version of versions
    .listAll()
    .filter((item) => item.reclaimedAtMs !== null)) {
    const relativePath = version.versionRelativePath;
    if (failedPaths.includes(relativePath)) continue;
    try {
      await removePath(resolve(input.layout.root, relativePath));
    } catch {
      failedPaths.push(relativePath);
    }
  }

  const quarantine = await reclaimQuarantine({
    cutoffMs,
    layout: input.layout,
    removePath,
  });
  failedPaths.push(...quarantine.failed);
  return Object.freeze({
    failedPaths: Object.freeze([...new Set(failedPaths)].sort()),
    reclaimedVersionIds: Object.freeze(reclaimedVersionIds),
    removedQuarantinePaths: Object.freeze(quarantine.removed.sort()),
  });
}
