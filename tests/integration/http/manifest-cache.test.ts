import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PublishedBookService,
  resetPublishedManifestCacheForTests,
} from "@/modules/reader/adapters/filesystem/published-book";
import { VersionArtifactIndexCache } from "@/modules/reader/adapters/filesystem/version-artifact-index";
import { DraftArtifactReader } from "@/modules/publishing/adapters/filesystem/draft-artifacts";

import { withMigratedTestDatabase } from "../../helpers/database.js";
import {
  publishReadyCandidateForTest,
  publicationTestVersionId,
  setupPublicationFixture,
} from "../../helpers/publication.js";

const anonymous = {
  allowed: false,
  reason: "UNAUTHENTICATED",
} as const;
const blockId = "blk_manifest_cache_test_0001";
const resourceId = "res_manifest_cache_test_0001";

function manifest(bookId: number): Readonly<Record<string, unknown>> {
  return {
    blocks: {
      [blockId]: {
        kind: "heading",
        normalized_visible_text: "Chapter",
        page_id: 1,
        resource_ids: [resourceId],
      },
    },
    book_id: bookId,
    compiler: {
      name: "mirawind-book-compiler",
      renderer_version: "semantic-html-v8-katex-0.18.1",
      text_normalization_version: 1,
      version: "compiler-v8",
    },
    source_updated_at: 1000,
    created_at: "2026-07-24T00:00:00.000Z",
    pages: [
      {
        block_ids: [blockId],
        first_block_id: blockId,
        output_path: "published/pages/1.html",
        page_id: 1,
        alias: "chapter-one",
        title: "Chapter",
      },
    ],
    resources: {
      [resourceId]: {
        media_type: "image/png",
        output_path: `assets/${resourceId}.png`,
        sha256: "e".repeat(64),
        size: 3,
        source_path: `assets/${resourceId}.png`,
      },
    },
    schema_version: 5,
    toc: [
      {
        block_id: blockId,
        level: 1,
        number: "1",
        page_id: 1,
        role: "body",
        title: "Chapter",
      },
    ],
    version_id: publicationTestVersionId,
  };
}

describe("immutable published manifest cache", () => {
  beforeEach(resetPublishedManifestCacheForTests);
  afterEach(resetPublishedManifestCacheForTests);

  it("reuses a validated immutable manifest and misses when its database hash changes", () =>
    withMigratedTestDatabase(async ({ database }, dataRoot) => {
      const fixture = setupPublicationFixture(database);
      await publishReadyCandidateForTest({
        bookId: fixture.book.id,
        database,
        nowMs: 12,
      });
      const versionDirectory = resolve(
        dataRoot.layout.root,
        "books",
        String(fixture.book.id),
        "builds",
        publicationTestVersionId,
      );
      await mkdir(versionDirectory, { mode: 0o700, recursive: true });
      const manifestPath = resolve(versionDirectory, "document-manifest.json");
      await writeFile(
        manifestPath,
        `${JSON.stringify(manifest(fixture.book.id))}\n`,
        { mode: 0o600 },
      );
      const service = new PublishedBookService(database, dataRoot.layout);
      const input = {
        administrator: anonymous,
        bookKey: String(fixture.book.id),
        pageKey: "1",
      };

      await expect(service.resolvePage(input)).resolves.toMatchObject({
        pageId: 1,
        versionId: publicationTestVersionId,
      });
      await writeFile(manifestPath, "{invalid", { mode: 0o600 });
      await expect(service.resolvePage(input)).resolves.toMatchObject({
        pageId: 1,
        versionId: publicationTestVersionId,
      });

      database
        .prepare("UPDATE book_versions SET manifest_sha256 = ? WHERE id = ?")
        .run("d".repeat(64), publicationTestVersionId);
      await expect(service.resolvePage(input)).rejects.toMatchObject({
        code: "BOOK_UNAVAILABLE",
        status: 503,
      });
    }));

  it("shares one cold load and resolves page, alias and resource indexes exactly", () =>
    withMigratedTestDatabase(async ({ database }, dataRoot) => {
      const fixture = setupPublicationFixture(database);
      await publishReadyCandidateForTest({
        bookId: fixture.book.id,
        database,
        nowMs: 12,
      });
      const versionDirectory = resolve(
        dataRoot.layout.root,
        "books",
        String(fixture.book.id),
        "builds",
        publicationTestVersionId,
      );
      await mkdir(versionDirectory, { mode: 0o700, recursive: true });
      await writeFile(
        resolve(versionDirectory, "document-manifest.json"),
        `${JSON.stringify(manifest(fixture.book.id))}\n`,
        { mode: 0o600 },
      );

      let reads = 0;
      let releaseLoad: () => void = () => {};
      const loadReleased = new Promise<void>((resolveLoad) => {
        releaseLoad = resolveLoad;
      });
      let markStarted: () => void = () => {};
      const loadStarted = new Promise<void>((resolveStarted) => {
        markStarted = resolveStarted;
      });
      const indexes = new VersionArtifactIndexCache(async (path) => {
        reads += 1;
        markStarted();
        await loadReleased;
        return readFile(path, "utf8");
      });
      const service = new PublishedBookService(
        database,
        dataRoot.layout,
        indexes,
      );
      const requests = Array.from({ length: 40 }, () =>
        service.resolvePage({
          administrator: anonymous,
          bookKey: String(fixture.book.id),
          pageKey: "1",
        }),
      );

      await loadStarted;
      expect(reads).toBe(1);
      releaseLoad();
      await expect(Promise.all(requests)).resolves.toHaveLength(40);
      await expect(
        service.resolvePage({
          administrator: anonymous,
          bookKey: String(fixture.book.id),
          pageKey: "chapter-one",
        }),
      ).resolves.toMatchObject({ pageAlias: "chapter-one", pageId: 1 });
      await expect(
        service.resolveAsset({
          administrator: anonymous,
          bookKey: String(fixture.book.id),
          resourceId,
          versionId: publicationTestVersionId,
        }),
      ).resolves.toMatchObject({ resourceId, sizeBytes: 3 });
      expect(reads).toBe(1);
    }));

  it("does not retain a failed cold load", () =>
    withMigratedTestDatabase(async ({ database }, dataRoot) => {
      const fixture = setupPublicationFixture(database);
      await publishReadyCandidateForTest({
        bookId: fixture.book.id,
        database,
        nowMs: 12,
      });
      const json = `${JSON.stringify(manifest(fixture.book.id))}\n`;
      let reads = 0;
      const indexes = new VersionArtifactIndexCache(async () => {
        reads += 1;
        return reads === 1 ? "{invalid" : json;
      });
      const service = new PublishedBookService(
        database,
        dataRoot.layout,
        indexes,
      );
      const input = {
        administrator: anonymous,
        bookKey: String(fixture.book.id),
        pageKey: "1",
      };

      await expect(service.resolvePage(input)).rejects.toMatchObject({
        code: "BOOK_UNAVAILABLE",
        status: 503,
      });
      await expect(service.resolvePage(input)).resolves.toMatchObject({
        pageId: 1,
      });
      expect(reads).toBe(2);
    }));

  it("streams preview resources from validated manifest metadata", () =>
    withMigratedTestDatabase(async ({ database }, dataRoot) => {
      const fixture = setupPublicationFixture(database);
      const versionRelativePath = `books/${fixture.book.id}/builds/${publicationTestVersionId}`;
      const versionDirectory = resolve(
        dataRoot.layout.root,
        versionRelativePath,
      );
      await mkdir(
        resolve(
          dataRoot.layout.bookDirectory,
          String(fixture.book.id),
          "assets",
        ),
        {
          mode: 0o700,
          recursive: true,
        },
      );
      await mkdir(versionDirectory, { recursive: true });
      await writeFile(
        resolve(versionDirectory, "document-manifest.json"),
        `${JSON.stringify(manifest(fixture.book.id))}\n`,
        { mode: 0o600 },
      );
      await writeFile(
        resolve(
          dataRoot.layout.bookDirectory,
          String(fixture.book.id),
          "assets",
          resourceId + ".png",
        ),
        Uint8Array.from([1, 2, 3]),
        { mode: 0o600 },
      );

      const resource = await new DraftArtifactReader(
        dataRoot.layout,
      ).readPreviewResource({
        bookId: fixture.book.id,
        resourceId,
        versionId: publicationTestVersionId,
        versionRelativePath,
      });

      expect(resource.mediaType).toBe("image/png");
      expect(Object.hasOwn(resource, "bytes")).toBe(false);
      await expect(new Response(resource.body).arrayBuffer()).resolves.toEqual(
        Uint8Array.from([1, 2, 3]).buffer,
      );
    }));
});
