import { chmod, mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createSafeDiagnostic, type SafeDiagnostic } from "@/domain/errors";
import {
  buildSearchRowsForBlocks,
  buildSearchShortRows,
  type SearchRowCursor,
} from "../../core/publication/search-model";
import { materializeRouteNeutralHtmlVariants } from "./materialize-route-neutral-html";
import type { CompiledBook } from "../../core/publication/compiled-book";
import type { BookDocument } from "../../core/content/book-document.generated";
import { pageMetadata } from "../../core/publication/compiled-book";
import {
  renderPages,
  type PageRenderer,
  type PageReuse,
} from "../../core/publication/render-pages";
import type { ResourceResolution } from "../../core/publication/resource-model";
import type { BuildFileSink } from "../filesystem/build-file-inventory";
import { renderReaderHtmlDocument } from "@/web/features/reader/render-document";
import { renderReaderShell } from "@/web/features/reader/render";

const nonBlockingRenderDiagnosticCodes = new Set([
  "CODE_LANGUAGE_UNSUPPORTED",
  "MATH_RENDER_FAILED",
  "MERMAID_RENDER_INVALID",
]);

interface NavigationLink {
  readonly blockId: string;
  readonly level: number;
  readonly pageId: number;
  readonly title: string;
}

class JsonLineSpool {
  readonly #path: string;
  #buffer: string[] = [];
  #bufferBytes = 0;
  #handle: FileHandle | undefined;

  constructor(path: string) {
    this.#path = path;
  }

  async open(): Promise<void> {
    await mkdir(dirname(this.#path), { mode: 0o700, recursive: true });
    this.#handle = await open(this.#path, "wx", 0o600);
  }

  async #flush(): Promise<void> {
    if (!this.#handle) throw new Error("BUILD_SPOOL_NOT_OPEN");
    if (this.#buffer.length === 0) return;
    const chunk = this.#buffer.join("");
    this.#buffer = [];
    this.#bufferBytes = 0;
    await this.#handle.writeFile(chunk, "utf8");
  }

  async writeMany(values: readonly unknown[]): Promise<void> {
    if (!this.#handle) throw new Error("BUILD_SPOOL_NOT_OPEN");
    for (const value of values) {
      const line = `${JSON.stringify(value)}\n`;
      this.#buffer.push(line);
      const bytes = Buffer.byteLength(line);
      this.#bufferBytes += bytes;
    }
    if (this.#bufferBytes >= 256 * 1024) await this.#flush();
  }

  async close(): Promise<void> {
    const handle = this.#handle;
    if (!handle) return;
    await this.#flush();
    this.#handle = undefined;
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(this.#path, 0o400);
  }

  async abort(): Promise<void> {
    const handle = this.#handle;
    this.#handle = undefined;
    this.#buffer = [];
    this.#bufferBytes = 0;
    await handle?.close().catch(() => undefined);
    await rm(this.#path, { force: true });
  }
}

function assertNonBlockingDiagnostics(
  diagnostics: readonly SafeDiagnostic[],
): void {
  if (
    diagnostics.some(
      (diagnostic) => !nonBlockingRenderDiagnosticCodes.has(diagnostic.code),
    )
  ) {
    throw new Error("BUILD_RENDER_DIAGNOSTIC");
  }
}

function diagnosticWithBlockTarget(input: {
  readonly diagnostic: SafeDiagnostic;
  readonly headingIds: ReadonlySet<string>;
  readonly pageId: number | null;
}): SafeDiagnostic {
  const blockId =
    input.diagnostic.location?.blockId ?? input.diagnostic.blockId ?? null;
  if (!blockId || input.pageId === null) return input.diagnostic;
  return createSafeDiagnostic({
    ...input.diagnostic,
    targets: Object.freeze([
      ...(input.diagnostic.targets ?? []),
      {
        blockId,
        kind: input.headingIds.has(blockId)
          ? ("select_structure" as const)
          : ("edit_block" as const),
        pageId: input.pageId,
      },
    ]),
  });
}

export interface BuildMaterializationResult {
  readonly diagnostics: readonly SafeDiagnostic[];
  readonly manifestPageCount: number;
  readonly pageByHeading: ReadonlyMap<string, number>;
  readonly pageCount: number;
  readonly searchFtsRowCount: number;
  readonly searchShortRowCount: number;
}

export async function materializeBuildPages(input: {
  readonly bookId: number;
  readonly buildDirectory: string;
  readonly compiled: CompiledBook;
  readonly bookDocument: BookDocument;
  readonly sourceUpdatedAt: number;
  readonly files: BuildFileSink;
  readonly originalFiles: readonly Readonly<Record<string, unknown>>[];
  readonly onPageRendered?: (completed: number, total: number) => void;
  readonly onSearchFinalizing?: (total: number) => void;
  readonly preparationDiagnostics?: readonly SafeDiagnostic[];
  readonly renderPage?: PageRenderer;
  readonly reusePage?: PageReuse;
  readonly resourceResolution: ResourceResolution;
  readonly signal?: AbortSignal;
  readonly versionId: string;
}): Promise<BuildMaterializationResult> {
  const { compiled } = input;
  const previewDirectory = resolve(input.buildDirectory, "preview");
  const publishedDirectory = resolve(input.buildDirectory, "published");
  await Promise.all([
    mkdir(resolve(previewDirectory, "pages"), {
      mode: 0o700,
      recursive: true,
    }),
    mkdir(resolve(publishedDirectory, "pages"), {
      mode: 0o700,
      recursive: true,
    }),
    mkdir(resolve(publishedDirectory, "styles"), {
      mode: 0o700,
      recursive: true,
    }),
  ]);

  const searchSpool = new JsonLineSpool(
    resolve(input.buildDirectory, "../search-rows.ndjson"),
  );
  const pageByHeading = new Map<string, number>();
  const headingIds = new Set(
    compiled.headings.map((heading) => heading.block_id),
  );
  const headingsByPageId = new Map<
    number,
    CompiledBook["headings"][number][]
  >();
  const navigation: NavigationLink[] = [];
  for (const heading of compiled.headings) {
    const page = compiled.pageByHeadingId.get(heading.block_id);
    if (!page) throw new Error("BUILD_BLOCK_PAGE_MISSING");
    pageByHeading.set(heading.block_id, page.pageId);
    const pageHeadings = headingsByPageId.get(page.pageId) ?? [];
    pageHeadings.push(heading);
    headingsByPageId.set(page.pageId, pageHeadings);
    if (heading.include_in_toc) {
      navigation.push(
        Object.freeze({
          blockId: heading.block_id,
          level: heading.display_level,
          pageId: page.pageId,
          title: heading.label,
        }),
      );
    }
  }

  const metadata = input.bookDocument.metadata;
  const authors = Array.isArray(metadata?.authors)
    ? metadata.authors.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const language =
    typeof metadata?.language === "string" ? metadata.language : "zh-CN";
  const bookKey =
    typeof input.bookDocument.alias === "string"
      ? input.bookDocument.alias
      : String(input.bookId);
  const publicPageHref = (page: CompiledBook["pages"][number]) => {
    const pageKey = pageMetadata(compiled, page).alias ?? page.pageId;
    return `/read/${bookKey}/${pageKey}`;
  };
  const previewPageHref = (page: CompiledBook["pages"][number]) =>
    `/api/manage/books/${input.bookId}/preview/${input.versionId}/pages/${page.pageId}`;
  const navigationPage = (pageId: number) => {
    const page = compiled.pageById.get(pageId);
    if (!page) throw new Error("BUILD_PAGE_MISSING");
    return page;
  };
  const previewToc = navigation.map((link) => ({
    ...link,
    href: `${previewPageHref(navigationPage(link.pageId))}#${link.blockId}`,
  }));
  const publicToc = navigation.map((link) => ({
    ...link,
    href: `${publicPageHref(navigationPage(link.pageId))}#${link.blockId}`,
  }));
  const originalDownloads = input.originalFiles.map((original) => ({
    href: `/books/${bookKey}/originals/${String(original.id)}`,
    label:
      String(original.role) === "mineru_zip" ? "下载原始 ZIP" : "下载原文件",
  }));
  const diagnostics: SafeDiagnostic[] = [
    ...(input.preparationDiagnostics ?? []),
    ...input.resourceResolution.diagnostics,
  ].map((diagnostic) => {
    const blockId = diagnostic.location?.blockId ?? diagnostic.blockId;
    return diagnosticWithBlockTarget({
      diagnostic,
      headingIds,
      pageId: blockId
        ? (compiled.pageByBlockId.get(blockId)?.pageId ?? null)
        : null,
    });
  });
  const styles = new Set<string>();
  let searchCursor: SearchRowCursor = {
    currentHeading: "",
    nextOrdinal: 0,
  };
  let searchFtsRowCount = 0;
  let precedingTocHeadingId: string | null = null;

  try {
    await searchSpool.open();
    for await (const rendered of renderPages({
      book: compiled,
      ...(input.renderPage ? { renderPage: input.renderPage } : {}),
      ...(input.reusePage ? { reusePage: input.reusePage } : {}),
      resourceResolution: input.resourceResolution,
      ...(input.signal ? { signal: input.signal } : {}),
    })) {
      const renderedDiagnostics = rendered.diagnostics.map((diagnostic) =>
        diagnosticWithBlockTarget({
          diagnostic,
          headingIds,
          pageId: rendered.page.pageId,
        }),
      );
      assertNonBlockingDiagnostics(renderedDiagnostics);
      diagnostics.push(...renderedDiagnostics);
      if (rendered.css) styles.add(rendered.css);
      const { ordinal, page } = rendered;
      const nextPage = compiled.pages[ordinal + 1];
      const previousPage = compiled.pages[ordinal - 1];
      const pageHeadings = headingsByPageId.get(page.pageId) ?? [];
      const pageTocHeadings = pageHeadings.filter(
        (heading) => heading.include_in_toc,
      );
      const pageOwnerHeadingId = pageHeadings.at(0)?.block_id ?? null;
      const currentTocHeadingId =
        pageTocHeadings.at(0)?.block_id ?? precedingTocHeadingId;
      const outline = pageHeadings.map((heading) => ({
        blockId: heading.block_id,
        href: `#${heading.block_id}`,
        level: heading.display_level,
        title: heading.label,
      }));
      precedingTocHeadingId =
        pageTocHeadings.at(-1)?.block_id ?? precedingTocHeadingId;
      const materializedBody = materializeRouteNeutralHtmlVariants({
        html: rendered.html,
        preview: {
          blockHref(blockId) {
            const pageId = input.compiled.pageByBlockId.get(blockId)?.pageId;
            if (!pageId) throw new Error("BUILD_BLOCK_PAGE_MISSING");
            return `${previewPageHref(navigationPage(pageId))}#${blockId}`;
          },
          resourceUrl: (resourceId) =>
            `/api/manage/books/${input.bookId}/preview/${input.versionId}/assets/${resourceId}`,
        },
        published: {
          blockHref(blockId) {
            const pageId = input.compiled.pageByBlockId.get(blockId)?.pageId;
            if (!pageId) throw new Error("BUILD_BLOCK_PAGE_MISSING");
            return `${publicPageHref(navigationPage(pageId))}#${blockId}`;
          },
          resourceUrl: (resourceId) =>
            `/books/${input.bookId}/assets/${input.versionId}/${resourceId}`,
        },
        references: rendered.routeReferences,
      });
      const common = {
        bookKey,
        bookTitle: compiled.bookTitle,
        currentTocHeadingId,
        currentPageId: page.pageId,
        outline,
        pageOwnerHeadingId,
      };
      const previewHtml = renderReaderHtmlDocument({
        body: renderReaderShell({
          ...common,
          bodyHtml: materializedBody.preview,
          firstPageHref: previewPageHref(compiled.pages[0] ?? page),
          mode: "preview",
          nextHref: nextPage ? previewPageHref(nextPage) : null,
          originalDownloads: [],
          previousHref: previousPage ? previewPageHref(previousPage) : null,
          previewUpdatedAt: input.sourceUpdatedAt,
          previewBuildId: input.versionId,
          toc: previewToc,
        }),
        css: rendered.css,
        language,
        title: pageMetadata(compiled, page).title,
      });
      const publicHtml = renderReaderHtmlDocument({
        body: renderReaderShell({
          ...common,
          bodyHtml: materializedBody.published,
          firstPageHref: publicPageHref(compiled.pages[0] ?? page),
          mode: "published",
          nextHref: nextPage ? publicPageHref(nextPage) : null,
          originalDownloads,
          previousHref: previousPage ? publicPageHref(previousPage) : null,
          toc: publicToc,
        }),
        canonicalPath: publicPageHref(page),
        css: rendered.css,
        language,
        title: pageMetadata(compiled, page).title,
      });
      await Promise.all([
        input.files.write(`preview/pages/${page.pageId}.html`, previewHtml),
        input.files.write(`published/pages/${page.pageId}.html`, publicHtml),
      ]);
      const search = buildSearchRowsForBlocks({
        authors,
        blocks: compiled.document.blocks,
        book: compiled,
        bookId: input.bookId,
        cursor: searchCursor,
        endIndex: page.blockRange.end,
        startIndex: page.blockRange.start,
        title: compiled.bookTitle,
        versionId: input.versionId,
      });
      searchCursor = search.cursor;
      await searchSpool.writeMany(
        search.rows.map((row) => ({ kind: "fts", row })),
      );
      searchFtsRowCount += search.rows.length;
      input.onPageRendered?.(ordinal + 1, compiled.pages.length);
    }
    const shortRows = buildSearchShortRows({
      authors,
      book: compiled,
      bookId: input.bookId,
      title: compiled.bookTitle,
      versionId: input.versionId,
    });
    input.onSearchFinalizing?.(searchFtsRowCount + shortRows.length);
    await searchSpool.writeMany(
      shortRows.map((row) => ({ kind: "short", row })),
    );
    await searchSpool.close();

    const css = [...styles].sort().join("");
    await input.files.write("published/styles/document.css", css);
    return Object.freeze({
      diagnostics: Object.freeze(diagnostics),
      manifestPageCount: compiled.pages.length,
      pageByHeading,
      pageCount: compiled.pages.length,
      searchFtsRowCount,
      searchShortRowCount: shortRows.length,
    });
  } catch (error) {
    await searchSpool.abort();
    throw error;
  }
}
