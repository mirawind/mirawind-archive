import { required } from "../../helpers/required";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import * as rendering from "@/modules/publishing/core/publication/render-document";
import { DocumentRepository } from "@/modules/publishing/adapters/sqlite/documents";
import { BuildRepository } from "@/modules/publishing/adapters/sqlite/builds";
import { VersionRepository } from "@/modules/publishing/adapters/sqlite/versions";
import { saveDocument } from "@/modules/publishing/adapters/sqlite/save-document";
import { BuildPublicationRepository } from "@/modules/publishing/adapters/sqlite/build-publication";
import { BookPresentationRepository } from "@/modules/catalog/adapters/sqlite/book-presentations";
import { verifyVersionFully } from "@/composition/version-verification";
import {
  reclaimRetainedStorage,
  previewRetentionGraceMs,
} from "@/modules/publishing/adapters/worker/reclaim";
import { withMigratedTestDatabase } from "../../helpers/database";
import { prepareIrBook } from "../../helpers/prepare-ir-book";
import { buildSavedBook } from "../../helpers/build-book";
import {
  mineruTitle,
  mineruParagraph,
  mineruZip,
} from "../../helpers/mineru-v2";

describe("block storage publication", () => {
  it("shares original assets across builds and publishes only the saved preview", () =>
    withMigratedTestDatabase(async ({ database }, { layout }) => {
      const image = await sharp({
        create: { width: 2, height: 2, channels: 3, background: "white" },
      })
        .png()
        .toBuffer();
      const fixture = await prepareIrBook(
        database,
        layout,
        mineruZip(
          [
            [
              mineruTitle("Book"),
              mineruParagraph("Initial body"),
              mineruTitle("Next chapter"),
              mineruParagraph("Linked body"),
              {
                type: "image",
                content: {
                  image_source: { path: "images/test.png" },
                  image_caption: [],
                  image_footnote: [],
                },
              },
            ],
          ],
          [{ name: "result/images/test.png", data: image }],
        ),
      );
      const documents = new DocumentRepository(database),
        builds = new BuildRepository(database);
      const build = () => buildSavedBook(database, layout);
      let initial = documents.read(fixture.book.id);
      saveDocument({
        bookId: fixture.book.id,
        database,
        expectedUpdatedAt: initial.updated_at,
        requestId: "setup_link_request_001",
        nowMs: Date.now(),
        patch: {
          numbering: "generated",
          blocks: [
            {
              block_id: required(initial.blocks[3]).id,
              markdown: `[Back](#${required(initial.blocks[0]).id})`,
            },
          ],
        },
      });
      initial = documents.read(fixture.book.id);
      const render = vi.spyOn(rendering, "renderSemanticDocument");
      const resource = required(initial.resources[0]);
      const assetPath = resolve(
        layout.bookDirectory,
        String(fixture.book.id),
        resource.path,
      );
      const before = await stat(assetPath);
      const first = await build();
      expect(render).toHaveBeenCalledTimes(2);
      render.mockClear();
      const publication = new BuildPublicationRepository(database);
      publication.promote({
        actorUserId: null,
        bookId: fixture.book.id,
        buildId: first.versionId,
        expectedVersionId: first.versionId,
        expectedUpdatedAt: initial.updated_at,
        nowMs: Date.now(),
      });
      const firstVersion = new VersionRepository(database).require(
        first.versionId,
      );
      const firstPage = resolve(
        layout.root,
        firstVersion.versionRelativePath,
        "published/pages/1.html",
      );
      const originalHtml = await readFile(firstPage, "utf8");
      const saved = saveDocument({
        bookId: fixture.book.id,
        database,
        expectedUpdatedAt: initial.updated_at,
        patch: {
          blocks: [
            {
              block_id: required(initial.blocks[1]).id,
              markdown: "Edited paragraph",
            },
          ],
        },
        requestId: "save_request_00000001",
        nowMs: Date.now(),
      });
      expect(await readFile(firstPage, "utf8")).toBe(originalHtml);
      expect(() =>
        publication.capture({
          bookId: fixture.book.id,
          buildId: first.versionId,
          expectedUpdatedAt: saved.updated_at,
        }),
      ).toThrow();
      const second = await build();
      expect(render).toHaveBeenCalledTimes(1);
      const secondVersion = new VersionRepository(database).require(
        second.versionId,
      );
      const reusedPreview = await readFile(
        resolve(
          layout.root,
          secondVersion.versionRelativePath,
          "preview/pages/2.html",
        ),
        "utf8",
      );
      expect(reusedPreview).toContain(
        `/preview/${second.versionId}/pages/1#${required(initial.blocks[0]).id}`,
      );
      expect(reusedPreview).toContain(
        `/preview/${second.versionId}/assets/${resource.id}`,
      );
      expect(await verifyVersionFully(layout, secondVersion)).toEqual({
        ok: true,
      });
      expect((await stat(assetPath)).ino).toBe(before.ino);
      expect(await readFile(assetPath)).toEqual(image);
      const marker = JSON.parse(
        await readFile(
          resolve(
            layout.root,
            secondVersion.versionRelativePath,
            "version.json",
          ),
          "utf8",
        ),
      );
      expect(marker.shared_files).toHaveLength(1);
      const sharedBytes = marker.shared_files.reduce(
        (sum: number, file: { size: number }) => sum + file.size,
        0,
      );
      expect(sharedBytes).toBe(image.length);
      for (const file of marker.files as { path: string }[])
        expect(
          file.path.startsWith("assets/") ||
            file.path.startsWith("originals/") ||
            file.path.startsWith("published/assets/"),
        ).toBe(false);
      publication.promote({
        actorUserId: null,
        bookId: fixture.book.id,
        buildId: second.versionId,
        expectedVersionId: second.versionId,
        expectedUpdatedAt: saved.updated_at,
        nowMs: Date.now(),
      });
      expect(
        database
          .prepare("SELECT current_version_id FROM books WHERE id=?")
          .get(fixture.book.id),
      ).toEqual({ current_version_id: second.versionId });
      expect(await readFile(firstPage, "utf8")).toBe(originalHtml);
      render.mockClear();
      saveDocument({
        bookId: fixture.book.id,
        database,
        expectedUpdatedAt: saved.updated_at,
        requestId: "heading_number_change_001",
        nowMs: Date.now(),
        patch: {
          blocks: [
            {
              block_id: required(initial.blocks[0]).id,
              exclude_from_numbering: true,
            },
          ],
        },
      });
      const third = await build();
      database
        .prepare("UPDATE book_versions SET complete_at=1 WHERE id=?")
        .run(third.versionId);
      expect(render).toHaveBeenCalledTimes(2);
      saveDocument({
        bookId: fixture.book.id,
        database,
        expectedUpdatedAt: documents.timestamp(fixture.book.id),
        requestId: "discard_preview_edit_001",
        nowMs: Date.now(),
        patch: {
          blocks: [
            {
              block_id: required(initial.blocks[1]).id,
              markdown: "Latest preview",
            },
          ],
        },
      });
      const latest = await build();
      expect(
        (
          await reclaimRetainedStorage({
            database,
            layout,
            nowMs: Date.now(),
            presentationRemover: new BookPresentationRepository(database),
          })
        ).reclaimedVersionIds,
      ).toEqual([]);
      const reclaimed = await reclaimRetainedStorage({
        database,
        layout,
        nowMs: Date.now() + previewRetentionGraceMs + 1,
        presentationRemover: new BookPresentationRepository(database),
      });
      expect(reclaimed.reclaimedVersionIds).toEqual([third.versionId]);
      expect(builds.findReadable(third.versionId, fixture.book.id)).toBeNull();
      expect(
        builds.findReadable(latest.versionId, fixture.book.id)?.state,
      ).toBe("ready");
      expect(await readFile(firstPage, "utf8")).toBe(originalHtml);
      expect(await readFile(assetPath)).toEqual(image);
      await chmod(assetPath, 0o600);
      const corrupted = Buffer.from(image);
      corrupted[corrupted.length - 1] =
        required(corrupted[corrupted.length - 1]) ^ 1;
      await writeFile(assetPath, corrupted);
      expect((await verifyVersionFully(layout, secondVersion)).ok).toBe(false);
      await writeFile(assetPath, image);
      expect((await verifyVersionFully(layout, secondVersion)).ok).toBe(true);
    }));
});
