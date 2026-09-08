import { createHash } from "node:crypto";

import type { ResolvedResource } from "./resource-model";
import type { CompiledBook } from "./compiled-book";
import { pageBlockIds, pageMetadata, pageOutputPath } from "./compiled-book";
import { validateDocumentManifest } from "./document-manifest-schema";
import type { TransientDocumentNode } from "../preparation/document-model";

export const compilerIdentity = Object.freeze({
  name: "mirawind-book-compiler" as const,
  renderer_version: "semantic-html-v8-katex-0.18.1",
  text_normalization_version: 2,
  version: "compiler-v8",
});
export interface ManifestSourceFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}
export interface ManifestResource extends ResolvedResource {
  readonly height: number;
  readonly mediaType: string;
  readonly outputPath: string;
  readonly sha256: string;
  readonly size: number;
  readonly width: number;
}
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) =>
          Buffer.from(left).compare(Buffer.from(right)),
        )
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  return value;
}
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value)) + "\n";
}
export function semanticCompilationDigest(value: unknown): string {
  return createHash("sha256")
    .update("mirawind-semantic-compilation-v2\0")
    .update(canonicalJson(value))
    .digest("hex");
}
export function buildManifestPageRecord(
  book: CompiledBook,
  page: CompiledBook["pages"][number],
): Readonly<Record<string, unknown>> {
  const metadata = pageMetadata(book, page);
  return {
    ...(metadata.alias ? { alias: metadata.alias } : {}),
    block_ids: pageBlockIds(book, page),
    first_block_id: page.firstBlockId,
    output_path: pageOutputPath(page),
    page_id: page.pageId,
    title: metadata.title,
  };
}
export function buildDocumentManifest(input: {
  readonly bookId: number;
  readonly book: CompiledBook;
  readonly createdAt: string;
  readonly resources: readonly ManifestResource[];
  readonly versionId: string;
}): Readonly<Record<string, unknown>> {
  const resourceIdByPath = new Map(
    input.book.book.resources.map((resource) => [resource.path, resource.id]),
  );
  function resourceIds(node: TransientDocumentNode): string[] {
    const ids = new Set<string>();
    function visit(current: TransientDocumentNode): void {
      if (current.url) {
        const id = resourceIdByPath.get(current.url);
        if (id) ids.add(id);
      }
      for (const child of current.children ?? []) visit(child);
    }
    visit(node);
    return [...ids];
  }
  const blocks = Object.fromEntries(
    input.book.document.blocks.map((block) => {
      if (!block.blockId || !block.contentKind)
        throw new Error("MANIFEST_BLOCK_IDENTITY_MISSING");
      const pageId = input.book.pageByBlockId.get(block.blockId)?.pageId;
      if (!pageId) throw new Error("MANIFEST_BLOCK_PAGE_MISSING");
      return [
        block.blockId,
        {
          kind: block.contentKind,
          normalized_visible_text: (
            input.book.headingByBlockId.get(block.blockId)?.label ??
            block.visibleText ??
            ""
          )
            .replaceAll("\r\n", "\n")
            .normalize("NFC"),
          page_id: pageId,
          resource_ids: resourceIds(block),
        },
      ];
    }),
  );
  return validateDocumentManifest({
    schema_version: 5,
    book_id: input.bookId,
    source_updated_at: input.book.book.updated_at,
    version_id: input.versionId,
    compiler: compilerIdentity,
    created_at: input.createdAt,
    blocks,
    pages: input.book.pages.map((page) =>
      buildManifestPageRecord(input.book, page),
    ),
    resources: Object.fromEntries(
      input.resources.map((resource) => [
        resource.id,
        {
          height: resource.height,
          width: resource.width,
          media_type: resource.mediaType,
          output_path: resource.outputPath,
          source_path: resource.relativePath,
          sha256: resource.sha256,
          size: resource.size,
        },
      ]),
    ),
    toc: input.book.headings
      .filter((heading) => heading.include_in_toc)
      .map((heading) => {
        const page = input.book.pageByHeadingId.get(heading.block_id);
        if (!page) throw new Error("COMPILED_BOOK_HEADING_PAGE_MISSING");
        return {
          block_id: heading.block_id,
          level: heading.display_level,
          number: heading.number,
          title: heading.title,
          role: heading.role,
          page_id: page.pageId,
        };
      }),
  });
}
