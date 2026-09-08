import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { authorizePreviewHtmlResources } from "@/http/authorization/preview-resource";
import { responsePolicyFor } from "@/http/cache/policies";
import { materializeBuildPages } from "@/modules/publishing/adapters/reader-html/build-materializer";
import { createBuildFileInventory } from "@/modules/publishing/adapters/filesystem/build-file-inventory";
import { compileBook } from "@/modules/publishing/core/publication/compile-book";
import { renderSemanticDocument } from "@/modules/publishing/core/publication/render-document";
import { buildSearchSpool } from "@/modules/publishing/core/publication/search-model";
import { createTemporaryDataRoot } from "../../helpers/data-root.js";
import { smallBook, headingBlock, paragraphBlock } from "../../helpers/ir-book";

const headingIds = [
  "blk_candidate_preview_0001",
  "blk_candidate_preview_0002",
] as const;
const resourceId = "res_candidate_preview_0001";
const buildId = "ver_preview_fixture_000001";

function compiledFixture() {
  const document = smallBook(7);
  document.metadata = {
    title: "Candidate Preview",
    authors: ["Author"],
    language: "en",
  };
  document.publishing.numbering = "generated";
  document.publishing.boundaries.body_start_block_id = headingIds[0];
  document.resources = [
    { id: resourceId, path: "assets/diagram.png", media_type: "image/png" },
  ];
  document.blocks = [
    { ...headingBlock("First"), id: headingIds[0] },
    {
      ...paragraphBlock(""),
      content: [
        {
          type: "link",
          target: { type: "block", block_id: headingIds[1] },
          content: [{ type: "text", text: "Go to second" }],
        },
      ],
    },
    {
      id: "blk_candidate_preview_image0001",
      type: "image",
      resource_id: resourceId,
      alt: "Diagram",
    },
    { ...headingBlock("Second"), id: headingIds[1], include_in_toc: false },
    paragraphBlock("Body."),
  ];
  return { book: compileBook(document), document };
}

function article(html: string): string {
  const match = /<article[^>]*>([\s\S]*?)<\/article>/u.exec(html);
  if (!match?.[1]) throw new Error("TEST_READER_ARTICLE_MISSING");
  return match[1];
}

function normalizedArticle(html: string): string {
  return article(html)
    .replaceAll(`/api/manage/books/7/preview/${buildId}/pages/2`, "/page/2")
    .replaceAll(/\/read\/7\/2/gu, "/page/2")
    .replaceAll(`/api/manage/books/7/preview/${buildId}/assets/`, "/asset/")
    .replaceAll(
      /\/books\/7\/assets\/ver_preview_fixture_000001\//gu,
      "/asset/",
    );
}

describe("candidate preview materialization", () => {
  it("renders semantic pages once and applies isolated preview/public policies", async () => {
    const dataRoot = await createTemporaryDataRoot("candidate-preview");
    try {
      const { book, document } = compiledFixture();
      const buildDirectory = resolve(dataRoot.path, "candidate");
      const renderPage = vi.fn(renderSemanticDocument);
      const result = await materializeBuildPages({
        bookId: 7,
        buildDirectory,
        compiled: book,
        bookDocument: document,
        sourceUpdatedAt: document.updated_at,
        files: createBuildFileInventory(buildDirectory),
        originalFiles: [{ id: "orig_candidate_0001", role: "mineru_zip" }],
        renderPage,
        resourceResolution: {
          diagnostics: [],
          references: [{ originalUrl: "assets/diagram.png", resourceId }],
          resources: [
            {
              absolutePath: resolve(dataRoot.path, "diagram.png"),
              id: resourceId,
              originalUrl: "assets/diagram.png",
              relativePath: "assets/diagram.png",
            },
          ],
        },
        versionId: "ver_preview_fixture_000001",
      });

      expect(renderPage).toHaveBeenCalledTimes(book.pages.length);
      expect(result).toMatchObject({
        manifestPageCount: 2,
        pageCount: 2,
        searchFtsRowCount: 5,
        searchShortRowCount: 4,
      });
      const preview = await readFile(
        resolve(buildDirectory, "preview/pages/1.html"),
        "utf8",
      );
      const published = await readFile(
        resolve(buildDirectory, "published/pages/1.html"),
        "utf8",
      );
      const secondPreview = await readFile(
        resolve(buildDirectory, "preview/pages/2.html"),
        "utf8",
      );
      expect(normalizedArticle(preview)).toBe(normalizedArticle(published));
      expect(preview).toContain('<span class="heading-number">1 </span>First');
      expect(secondPreview).toContain(
        `data-reader-page-owner="${headingIds[1]}"`,
      );
      expect(secondPreview).toContain(
        '<span class="heading-number">2 </span>Second',
      );
      expect(preview).toContain('data-reader-mode="preview"');
      expect(preview).not.toContain('rel="canonical"');
      expect(preview).not.toContain("reader-book-search");
      expect(preview).toContain(
        `/api/manage/books/7/preview/${buildId}/assets/${resourceId}`,
      );
      expect(published).toContain('data-reader-mode="published"');
      expect(published).toContain('<link rel="canonical" href="/read/7/1">');
      expect(published).toContain(
        `/books/7/assets/ver_preview_fixture_000001/${resourceId}`,
      );
      expect(preview).not.toContain("/__mirawind__/");
      expect(published).not.toContain("/__mirawind__/");
      const signed = authorizePreviewHtmlResources({
        authSecret: "candidate-preview-secret",
        bookId: 7,
        html: preview,
        nowMs: 1_700_000_000_000,
        buildId,
        session: {
          authenticatedAtMs: 1_700_000_000_000,
          expiresAtMs: 1_700_003_600_000,
          sessionId: "session-candidate-preview",
          user: {
            email: "admin@example.test",
            id: "admin-candidate-preview",
            name: "Administrator",
          },
        },
      });
      expect(signed).toContain(`${resourceId}?authorization=`);
      expect(responsePolicyFor("draft")).toEqual({
        cacheControl: "private, no-store",
        robotsTag: "noindex, nofollow, noarchive, nosnippet",
      });

      const searchLines = (
        await readFile(resolve(buildDirectory, "../search-rows.ndjson"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(result.pageCount).toBe(2);
      expect(searchLines).toHaveLength(
        result.searchFtsRowCount + result.searchShortRowCount,
      );
      const expectedSearch = buildSearchSpool({
        authors: ["Author"],
        book,
        bookId: 7,
        title: "Candidate Preview",
        versionId: "ver_preview_fixture_000001",
      });
      expect(
        searchLines
          .filter((line) => line.kind === "fts")
          .map((line) => line.row),
      ).toEqual(expectedSearch.ftsRows);
      expect(
        searchLines
          .filter((line) => line.kind === "short")
          .map((line) => line.row),
      ).toEqual(expectedSearch.shortRows);
    } finally {
      await dataRoot.cleanup();
    }
  });
});
