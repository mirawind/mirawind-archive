import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import type Database from "better-sqlite3";

import type { BookVersionPresentationRemover } from "@/modules/catalog/application/catalog-api";
import { withImmediateTransaction } from "@/platform/sqlite/immediate-transaction";
import { reclaimResources, reclamationBatchSize } from "./reclaim-resources";
import type { StorageLayout } from "@/platform/filesystem/storage-layout";
import { removeExactContainedTree } from "@/platform/filesystem/permanent-removal";

export const versionRetentionGraceMs = 24 * 60 * 60 * 1_000;
export const previewRetentionGraceMs = 60 * 60 * 1_000;

export interface ReclamationResult {
  readonly failedPaths: readonly string[];
  readonly reclaimedVersionIds: readonly string[];
}

type RemovePath = (path: string) => Promise<void>;

export async function reclaimQuarantine(input: {
  readonly nowMs: number;
  readonly layout: StorageLayout;
  readonly removePath?: RemovePath;
}): Promise<{
  readonly failed: string[];
  readonly removed: string[];
}> {
  const failed: string[] = [];
  const removed: string[] = [];
  const removePath =
    input.removePath ??
    ((target: string) =>
      removeExactContainedTree({ root: input.layout.root, target }));
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
        quarantinedAtMs > input.nowMs - versionRetentionGraceMs
      ) {
        continue;
      }
      const relativePath = `books/${book.name}/quarantine/${entry.name}`;
      try {
        await removePath(resolve(directory, entry.name));
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
  const eligible = `books.deletion_requested_at IS NULL
    AND versions.id IS NOT books.current_version_id
    AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.book_id=versions.book_id AND jobs.state='running')
    AND versions.id <> COALESCE((
      SELECT previous.id FROM book_versions AS previous
      WHERE previous.book_id=versions.book_id AND previous.state='superseded'
        AND previous.reclaimed_at IS NULL AND previous.verified_at IS NOT NULL
        AND previous.published_at IS NOT NULL
      ORDER BY previous.published_at DESC,previous.id DESC LIMIT 1
    ), '')`;
  const pending = withImmediateTransaction(input.database, () => {
    const candidates = input.database
      .prepare(
        `SELECT versions.id,versions.book_id,versions.version_rel_path,versions.reclaimed_at
       FROM book_versions AS versions
       JOIN books ON books.id = versions.book_id
       WHERE versions.files_removed_at IS NULL AND ${eligible}
         AND (versions.reclaimed_at IS NOT NULL
           OR (versions.state IN ('superseded','corrupt') AND versions.retired_at<=@publishedCutoff)
           OR (versions.state='discarded' AND versions.retired_at<=@previewCutoff))
       ORDER BY COALESCE(versions.cleanup_attempted_at,0),versions.retired_at,versions.id LIMIT @limit`,
      )
      .all({
        publishedCutoff: cutoffMs,
        previewCutoff: input.nowMs - previewRetentionGraceMs,
        limit: reclamationBatchSize,
      }) as {
      id: string;
      book_id: number;
      version_rel_path: string;
      reclaimed_at: number | null;
    }[];
    for (const version of candidates) {
      input.database
        .prepare("UPDATE book_versions SET cleanup_attempted_at=? WHERE id=?")
        .run(input.nowMs, version.id);
      if (version.reclaimed_at !== null) continue;
      input.database
        .prepare("UPDATE book_versions SET reclaimed_at=? WHERE id=?")
        .run(input.nowMs, version.id);
      input.database
        .prepare("DELETE FROM book_version_resources WHERE version_id=?")
        .run(version.id);
      input.database
        .prepare("DELETE FROM search_short_fields WHERE version_id=?")
        .run(version.id);
      input.database
        .prepare("DELETE FROM search_fts WHERE version_id=?")
        .run(version.id);
      input.presentationRemover.delete(version.id);
      input.database
        .prepare(
          `INSERT INTO audit_events
        (actor_user_id,action,book_id,version_id,job_id,safe_metadata_json,created_at)
        VALUES (NULL,'book.version.reclaimed',?,?,NULL,'{}',?)`,
        )
        .run(version.book_id, version.id, input.nowMs);
    }
    return candidates;
  });
  const failedPaths: string[] = [];
  const reclaimedVersionIds = pending
    .filter((version) => version.reclaimed_at === null)
    .map((version) => version.id);
  for (const version of pending) {
    const relativePath = version.version_rel_path;
    try {
      await removePath(resolve(input.layout.root, relativePath));
      input.database
        .prepare(
          "UPDATE book_versions SET files_removed_at=? WHERE id=? AND reclaimed_at IS NOT NULL",
        )
        .run(input.nowMs, version.id);
    } catch {
      failedPaths.push(relativePath);
    }
  }

  failedPaths.push(...(await reclaimResources({ ...input, removePath })));
  return Object.freeze({
    failedPaths: Object.freeze([...new Set(failedPaths)].sort()),
    reclaimedVersionIds: Object.freeze(reclaimedVersionIds),
  });
}
