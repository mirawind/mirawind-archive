import { createHash } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { createOpaqueId } from "@/domain/ids";
import { DocumentRepository } from "@/modules/publishing/adapters/sqlite/documents";
import { ResourceRepository } from "@/modules/publishing/adapters/sqlite/resources";
import { JobRepository } from "@/modules/publishing/adapters/sqlite/jobs";
import { uploadDraftCover } from "@/modules/publishing/adapters/filesystem/draft-cover";
import {
  reclaimResources,
  resourceRetentionGraceMs,
} from "@/modules/publishing/adapters/worker/reclaim-resources";
import { atomicWriteFile } from "@/platform/filesystem/atomic-file";
import { withMigratedTestDatabase } from "../../helpers/database";
import { installIrDraft } from "../../helpers/ir-book";
import { required } from "../../helpers/required";
import { buildSavedBook } from "../../helpers/build-book";
import { BookPresentationRepository } from "@/modules/catalog/adapters/sqlite/book-presentations";
import { BuildPublicationRepository } from "@/modules/publishing/adapters/sqlite/build-publication";
import { saveDocument } from "@/modules/publishing/adapters/sqlite/save-document";
import {
  reclaimRetainedStorage,
  versionRetentionGraceMs,
} from "@/modules/publishing/adapters/worker/reclaim";

describe("resource ownership and reference reclamation", () => {
  it("retains a replaced cover for published predecessors, then reclaims it without touching the new publication", () =>
    withMigratedTestDatabase(async ({ database }, { layout }) => {
      const { book } = await installIrDraft(database, layout);
      const unused = createOpaqueId("resource");
      database
        .prepare(
          `INSERT INTO book_resources(id,book_id,storage_rel_path,media_type,size_bytes,sha256,created_at)
        VALUES (?,?,?,'image/png',1,?,1)`,
        )
        .run(
          unused,
          book.book_id,
          `books/${book.book_id}/assets/${unused}.png`,
          "a".repeat(64),
        );
      const documents = new DocumentRepository(database),
        publication = new BuildPublicationRepository(database);
      const bytes = await sharp({
        create: { width: 2, height: 2, channels: 3, background: "white" },
      })
        .png()
        .toBuffer();
      const upload = () =>
        uploadDraftCover({
          database,
          layout,
          bookId: book.book_id,
          expectedUpdatedAt: documents.timestamp(book.book_id),
          nowMs: Date.now(),
          bytes,
          filename: "cover.png",
        });
      const publish = async () => {
        const built = await buildSavedBook(database, layout);
        publication.promote({
          actorUserId: null,
          bookId: book.book_id,
          buildId: built.versionId,
          expectedVersionId: built.versionId,
          expectedUpdatedAt: documents.timestamp(book.book_id),
          nowMs: Date.now(),
        });
        return built.versionId;
      };
      const firstCover = await upload(),
        first = await publish();
      const secondCover = await upload(),
        second = await publish();
      const collect = (nowMs: number) =>
        reclaimRetainedStorage({
          database,
          layout,
          nowMs,
          presentationRemover: new BookPresentationRepository(database),
        });
      const future = Date.now() + versionRetentionGraceMs + 1000;
      expect((await collect(future)).reclaimedVersionIds).toEqual([]);
      const path = resolve(
        layout.bookDirectory,
        String(book.book_id),
        `assets/${firstCover.resource_id}.png`,
      );
      await stat(path);
      expect(
        database
          .prepare(
            "SELECT resource_id FROM book_version_resources WHERE version_id=?",
          )
          .pluck()
          .all(first),
      ).toEqual([firstCover.resource_id]);
      saveDocument({
        database,
        bookId: book.book_id,
        expectedUpdatedAt: documents.timestamp(book.book_id),
        nowMs: Date.now(),
        requestId: "third_publication_0001",
        patch: {
          blocks: [
            { block_id: required(book.blocks[1]).id, markdown: "Latest body" },
          ],
        },
      });
      const third = await publish();
      expect((await collect(future + 1)).reclaimedVersionIds).toEqual([first]);
      await stat(path);
      await collect(future + 1 + resourceRetentionGraceMs);
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        database
          .prepare("SELECT id FROM book_resources WHERE id=?")
          .get(firstCover.resource_id),
      ).toBeUndefined();
      expect(
        database
          .prepare("SELECT current_version_id FROM books WHERE id=?")
          .get(book.book_id),
      ).toEqual({ current_version_id: third });
      expect(
        database
          .prepare(
            "SELECT resource_id FROM book_version_resources WHERE version_id=?",
          )
          .pluck()
          .all(second),
      ).toEqual([secondCover.resource_id]);
      await stat(
        resolve(
          layout.bookDirectory,
          String(book.book_id),
          `assets/${secondCover.resource_id}.png`,
        ),
      );
    }));
  it("indexes nested inline references, captures only dependencies, and keeps unused source images selectable", () =>
    withMigratedTestDatabase(async ({ database }, { layout }) => {
      const { book, imported } = await installIrDraft(database, layout);
      const documents = new DocumentRepository(database);
      const ids = Array.from({ length: 3 }, () => createOpaqueId("resource"));
      for (const id of ids)
        database
          .prepare(
            `INSERT INTO book_resources
        (id,book_id,storage_rel_path,media_type,size_bytes,sha256,created_at,width,height)
        VALUES (?,?,?,'image/png',1,?,1,2,2)`,
          )
          .run(
            id,
            book.book_id,
            `books/${book.book_id}/assets/${id}.png`,
            "a".repeat(64),
          );
      const first = required(ids[0]),
        second = required(ids[1]);
      const body = required(book.blocks[1]);
      documents.edit({
        bookId: book.book_id,
        expectedUpdatedAt: book.updated_at,
        nowMs: 2000,
        requestId: "nested_resources_000001",
        onChanged() {},
        patch: {
          blocks: [
            {
              block_id: body.id,
              markdown: `Text **![image](assets/${first}.png)** and [attachment](assets/${second}.png)`,
            },
          ],
        },
      });
      expect(
        database
          .prepare(
            "SELECT resource_id FROM book_block_resources ORDER BY resource_id",
          )
          .pluck()
          .all(),
      ).toEqual([first, second].sort());
      expect(
        documents
          .captureBuild(book.book_id, 2000, imported.id)
          .book.resources.map((item) => item.id)
          .sort(),
      ).toEqual([first, second].sort());
      expect(
        new ResourceRepository(database).listImages(book.book_id),
      ).toHaveLength(3);
      documents.edit({
        bookId: book.book_id,
        expectedUpdatedAt: 2000,
        nowMs: 3000,
        requestId: "clear_references_000001",
        onChanged() {},
        patch: { blocks: [{ block_id: body.id, markdown: "Plain text" }] },
      });
      expect(
        documents.captureBuild(book.book_id, 3000, imported.id).resources,
      ).toEqual([]);
      await reclaimResources({
        database,
        layout,
        nowMs: 10 * resourceRetentionGraceMs,
        removePath: vi.fn(),
      });
      expect(
        new ResourceRepository(database).listImages(book.book_id),
      ).toHaveLength(3);
    }));

  it("protects draft and running inputs, rejects resurrection after marking, and retries failed removal", () =>
    withMigratedTestDatabase(async ({ database }, { layout }) => {
      const { book } = await installIrDraft(database, layout);
      const documents = new DocumentRepository(database);
      const bytes = await sharp({
        create: { width: 2, height: 2, channels: 3, background: "white" },
      })
        .png()
        .toBuffer();
      const cover = await uploadDraftCover({
        bookId: book.book_id,
        database,
        layout,
        expectedUpdatedAt: book.updated_at,
        nowMs: 2000,
        bytes,
        filename: "cover.png",
      });
      const path = resolve(
        layout.bookDirectory,
        String(book.book_id),
        `assets/${cover.resource_id}.png`,
      );
      const remove = vi.fn(async (target: string) => {
        await rm(target, { force: true });
      });
      const collect = (nowMs: number, removePath = remove) =>
        reclaimResources({ database, layout, nowMs, removePath });
      await collect(10000);
      expect(remove).not.toHaveBeenCalled();
      const replacement = await uploadDraftCover({
        bookId: book.book_id,
        database,
        layout,
        expectedUpdatedAt: cover.updated_at,
        nowMs: 3000,
        bytes,
        filename: "next.png",
      });
      const jobs = new JobRepository(database);
      const running = required(
        jobs.claimNext({ leaseOwner: "test", nowMs: 10000 }),
      );
      await collect(10000);
      expect(
        database
          .prepare("SELECT unreferenced_at FROM book_resources WHERE id=?")
          .get(cover.resource_id),
      ).toEqual({ unreferenced_at: null });
      jobs.completeSuccess({
        jobId: running.id,
        leaseOwner: "test",
        nowMs: 10001,
      });
      await collect(10002);
      await collect(10002 + resourceRetentionGraceMs - 1);
      expect(remove).not.toHaveBeenCalled();
      const failed = await collect(
        10002 + resourceRetentionGraceMs,
        vi.fn(async () => {
          expect(() =>
            documents.edit({
              bookId: book.book_id,
              expectedUpdatedAt: replacement.updated_at,
              nowMs: 9000,
              requestId: "resurrect_pending_0001",
              onChanged() {},
              patch: { metadata: { cover_resource_id: cover.resource_id } },
            }),
          ).toThrow();
          expect(() =>
            new ResourceRepository(database).registerVersion(
              book.book_id,
              "unused",
              [cover.resource_id],
            ),
          ).toThrow();
          throw new Error("disk unavailable");
        }),
      );
      expect(failed).toHaveLength(1);
      await stat(path);
      expect(
        new ResourceRepository(database)
          .listImages(book.book_id)
          .map((item) => item.resource_id),
      ).toEqual([replacement.resource_id]);
      expect(await collect(10003 + resourceRetentionGraceMs)).toEqual([]);
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      remove.mockClear();
      await collect(10004 + resourceRetentionGraceMs);
      expect(remove).not.toHaveBeenCalled();
      expect(documents.timestamp(book.book_id)).toBe(replacement.updated_at);
    }));

  it("does not let repeatedly failing deletions starve later resources", () =>
    withMigratedTestDatabase(async ({ database }, { layout }) => {
      const { book } = await installIrDraft(database, layout);
      const bytes = Buffer.from("registered data");
      for (let index = 0; index < 33; index++) {
        const id = createOpaqueId("resource"),
          path = `books/${book.book_id}/assets/${id}.png`;
        await atomicWriteFile(resolve(layout.root, path), bytes, {
          mode: 0o400,
        });
        database
          .prepare(
            `INSERT INTO book_resources(id,book_id,storage_rel_path,media_type,size_bytes,sha256,created_at,retention,unreferenced_at)
          VALUES (?,?,?,'image/png',?,?,?,'referenced',1)`,
          )
          .run(
            id,
            book.book_id,
            path,
            bytes.length,
            createHash("sha256").update(bytes).digest("hex"),
            index,
          );
      }
      const fail = vi.fn(async () => {
        throw new Error("disk unavailable");
      });
      await reclaimResources({
        database,
        layout,
        nowMs: resourceRetentionGraceMs + 1,
        removePath: fail,
      });
      expect(fail).toHaveBeenCalledTimes(32);
      const removed: string[] = [];
      await reclaimResources({
        database,
        layout,
        nowMs: resourceRetentionGraceMs + 2,
        removePath: async (path) => {
          removed.push(path);
          await rm(path);
        },
      });
      expect(removed).toHaveLength(32);
      expect(
        database
          .prepare(
            "SELECT count(*) AS count FROM book_resources WHERE cleanup_attempted_at IS NULL",
          )
          .get(),
      ).toEqual({ count: 0 });
    }));
});
