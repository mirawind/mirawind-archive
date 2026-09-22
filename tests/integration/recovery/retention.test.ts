import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { JobRepository } from "@/modules/publishing/adapters/sqlite/jobs";
import { BookPresentationRepository } from "@/modules/catalog/adapters/sqlite/book-presentations";
import { VersionRepository } from "@/modules/publishing/adapters/sqlite/versions";
import {
  reclaimRetainedStorage,
  reclaimQuarantine,
  versionRetentionGraceMs,
} from "@/modules/publishing/adapters/worker/reclaim";

import { createTemporaryDataRoot } from "../../helpers/data-root.js";
import {
  openMigratedTestDatabase,
  withMigratedTestDatabase,
} from "../../helpers/database.js";
import {
  publishReadyCandidateForTest,
  publicationTestVersionId,
  presentationForTest,
  setupPublicationFixture,
} from "../../helpers/publication.js";

const previousId = "ver_retention_previous_000001";
const oldId = "ver_retention_old_00000000001";
const failedCleanupId = "ver_retention_cleanup_000001";

describe("published version and orphan retention", () => {
  it("keeps corrupt current artifacts and starts their grace period at corruption", () =>
    withMigratedTestDatabase(async ({ database }, { layout }) => {
      const fixture = setupPublicationFixture(database);
      await publishReadyCandidateForTest({
        bookId: fixture.book.id,
        database,
        nowMs: 300,
      });
      const versions = new VersionRepository(database);
      const retiredAt = versionRetentionGraceMs * 2;
      versions.markCorrupt(publicationTestVersionId, retiredAt);
      const collect = (nowMs: number) =>
        reclaimRetainedStorage({
          database,
          layout,
          nowMs,
          presentationRemover: new BookPresentationRepository(database),
        });
      expect(
        (await collect(retiredAt + versionRetentionGraceMs))
          .reclaimedVersionIds,
      ).toEqual([]);
      database
        .prepare("UPDATE books SET current_version_id=NULL WHERE id=?")
        .run(fixture.book.id);
      expect(
        (await collect(retiredAt + versionRetentionGraceMs - 1))
          .reclaimedVersionIds,
      ).toEqual([]);
      expect(
        (await collect(retiredAt + versionRetentionGraceMs))
          .reclaimedVersionIds,
      ).toEqual([publicationTestVersionId]);
      const deleted: string[] = [];
      await reclaimRetainedStorage({
        database,
        layout,
        nowMs: retiredAt + versionRetentionGraceMs + 1,
        presentationRemover: new BookPresentationRepository(database),
        removePath: async (path) => {
          deleted.push(path);
        },
      });
      expect(deleted).toEqual([]);
    }));
  it("preserves current/previous, tombstones older versions after 24 hours and retries file cleanup", async () => {
    const root = await createTemporaryDataRoot("retention");
    const migrated = await openMigratedTestDatabase(root);
    try {
      const fixture = setupPublicationFixture(migrated.database);
      await publishReadyCandidateForTest({
        bookId: fixture.book.id,
        database: migrated.database,
        nowMs: 300,
      });
      const jobs = new JobRepository(migrated.database);
      const jobIds = [oldId, previousId, failedCleanupId].map(
        (versionId, index) => {
          const job = jobs.create({
            bookId: fixture.book.id,
            kind: "build_book",
            nowMs: 400 + index,
          });
          jobs.fail(job.id, {
            errorClass: "content",
            errorCode: "TEST_RETAINED_VERSION",
            nowMs: 500 + index,
          });
          return [versionId, job.id] as const;
        },
      );
      const versionPath = (versionId: string) =>
        `books/${fixture.book.id}/builds/${versionId}`;
      const insert = migrated.database.prepare(
        `INSERT INTO book_versions (
           id, book_id, import_id, source_updated_at, predecessor_version_id,
           state, version_rel_path, manifest_schema_version, manifest_sha256,
           version_marker_sha256, semantic_digest, compiler_version,
           renderer_version, preview_version, reader_version,
           blocking_diagnostic_count, complete_at, published_at, verified_at,
           created_by_job_id, reclaimed_at
         ) VALUES (?, ?, ?, 1000, ?, 'superseded', ?, 5, ?, ?, ?, 'compiler-v8',
                   'semantic-html-v8-katex-0.18.1', 'draft-preview-v8',
                   'mirawind-reader-v5-tailwind-4.3.3', 0, ?, ?, ?, ?, NULL)`,
      );
      insert.run(
        oldId,
        fixture.book.id,
        fixture.imported.id,
        null,
        versionPath(oldId),
        "b".repeat(64),
        "b".repeat(64),
        "b".repeat(64),
        50,
        50,
        50,
        jobIds[0]?.[1],
      );
      insert.run(
        previousId,
        fixture.book.id,
        fixture.imported.id,
        oldId,
        versionPath(previousId),
        "c".repeat(64),
        "c".repeat(64),
        "c".repeat(64),
        200,
        200,
        200,
        jobIds[1]?.[1],
      );
      insert.run(
        failedCleanupId,
        fixture.book.id,
        fixture.imported.id,
        previousId,
        versionPath(failedCleanupId),
        "d".repeat(64),
        "d".repeat(64),
        "d".repeat(64),
        25,
        25,
        25,
        jobIds[2]?.[1],
      );
      const presentations = new BookPresentationRepository(migrated.database);
      migrated.database
        .prepare(
          "UPDATE book_versions SET retired_at=published_at WHERE state='superseded'",
        )
        .run();
      for (const versionId of [oldId, previousId, failedCleanupId]) {
        presentations.insert(presentationForTest(fixture.book.id, versionId));
      }
      for (const versionId of [
        publicationTestVersionId,
        previousId,
        oldId,
        failedCleanupId,
      ]) {
        await mkdir(resolve(root.layout.root, versionPath(versionId)), {
          recursive: true,
        });
      }
      migrated.database
        .prepare(
          `INSERT INTO search_fts (
             title, authors, heading, body, book_id, version_id,
             page_id, block_id, kind, ordinal
           ) VALUES ('old', '', '', 'old body', ?, ?, 1, 'blk_old', 'paragraph', 0)`,
        )
        .run(fixture.book.id, oldId);
      migrated.database
        .prepare(
          `INSERT INTO search_short_fields (
             book_id, version_id, page_id, block_id,
             kind, normalized_text, ordinal
           ) VALUES (?, ?, 1, NULL, 'title', 'old', 0)`,
        )
        .run(fixture.book.id, oldId);

      const nowMs = 2 * versionRetentionGraceMs;
      const quarantine = resolve(
        root.layout.bookDirectory,
        String(fixture.book.id),
        "quarantine",
      );
      await mkdir(resolve(quarantine, "old-orphan.1"), { recursive: true });
      await mkdir(resolve(quarantine, `recent-orphan.${nowMs}`), {
        recursive: true,
      });

      const first = await reclaimRetainedStorage({
        database: migrated.database,
        layout: root.layout,
        nowMs,
        presentationRemover: presentations,
        async removePath(path) {
          if (path.endsWith(failedCleanupId)) {
            throw new Error("SIMULATED_CLEANUP_FAILURE");
          }
          await rm(path, { force: true, recursive: true });
        },
      });
      expect(first.reclaimedVersionIds).toEqual([failedCleanupId, oldId]);
      expect(first.failedPaths).toEqual([versionPath(failedCleanupId)]);
      const quarantineResult = await reclaimQuarantine({
        layout: root.layout,
        nowMs,
      });
      expect(quarantineResult.removed).toEqual([
        `books/${fixture.book.id}/quarantine/old-orphan.1`,
      ]);
      const versions = new VersionRepository(migrated.database);
      expect(
        versions.require(publicationTestVersionId).reclaimedAtMs,
      ).toBeNull();
      expect(versions.require(previousId).reclaimedAtMs).toBeNull();
      expect(versions.require(oldId).reclaimedAtMs).toBe(nowMs);
      expect(versions.require(failedCleanupId).reclaimedAtMs).toBe(nowMs);
      expect(presentations.find(oldId)).toBeNull();
      expect(presentations.find(failedCleanupId)).toBeNull();
      expect(presentations.find(previousId)).not.toBeNull();
      expect(fixture.drafts.requireBook(fixture.book.id).currentVersionId).toBe(
        publicationTestVersionId,
      );
      expect(
        migrated.database
          .prepare(
            "SELECT COUNT(*) AS count FROM search_fts WHERE version_id = ?",
          )
          .get(oldId),
      ).toEqual({ count: 0 });
      await expect(
        stat(resolve(root.layout.root, versionPath(oldId))),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await stat(resolve(root.layout.root, versionPath(failedCleanupId)));
      await stat(resolve(quarantine, `recent-orphan.${nowMs}`));

      const retry = await reclaimRetainedStorage({
        database: migrated.database,
        layout: root.layout,
        nowMs: nowMs + 1,
        presentationRemover: presentations,
      });
      expect(retry.failedPaths).toEqual([]);
      expect(retry.reclaimedVersionIds).toEqual([]);
      await expect(
        stat(resolve(root.layout.root, versionPath(failedCleanupId))),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      migrated.close();
      await root.cleanup();
    }
  });
});
