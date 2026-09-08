import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import type { SafeDiagnostic } from "@/domain/errors";
import { resolveContainedPath } from "@/platform/filesystem/contained-path";
import type {
  BookDocument,
  ContentBlock,
} from "../../core/content/book-document.generated";
import { validateBookDocument } from "../../core/content/book-document";
import { contentEntries } from "../../core/content/content-tree";
import type { CompiledBook } from "../../core/publication/compiled-book";
import { presentDocumentHeadings } from "../../core/publication/heading-presentation";
import { validateVersionMarker } from "../../core/publication/document-manifest-schema";
import { katexCriticalCss } from "../../core/publication/render-assets";
import type { PageReuse } from "../../core/publication/render-pages";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
function hasFootnote(node: {
  type: string;
  children?: readonly { type: string }[];
}): boolean {
  return (
    node.type === "footnoteReference" ||
    node.type === "footnoteDefinition" ||
    (node.children ?? []).some((child) => hasFootnote(child))
  );
}
function* elements(node: Node): Generator<Element> {
  if ("tagName" in node) yield node;
  if ("childNodes" in node)
    for (const child of node.childNodes) yield* elements(child);
}
const digest = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const globalInputs = (book: BookDocument) =>
  JSON.stringify({
    metadata: book.metadata,
    publishing: book.publishing,
    resources: book.resources,
  });

export async function createPageReuse(input: {
  bookRoot: string;
  compiled: CompiledBook;
  previous: { id: string; markerSha256: string } | null;
}): Promise<PageReuse | undefined> {
  // Large navigation shells cost more to parse for reuse than fresh page rendering.
  if (!input.previous || input.compiled.pages.length > 100) return;
  try {
    const previous = input.previous;
    const root = resolve(input.bookRoot, "builds", previous.id);
    if ((await stat(resolve(root, "book.json"))).size > 32 * 1024 * 1024)
      return;
    const markerBytes = await readFile(resolve(root, "version.json"));
    if (digest(markerBytes) !== previous.markerSha256) return;
    const marker = validateVersionMarker(
      JSON.parse(markerBytes.toString("utf8")),
    );
    if (
      marker.book_id !== input.compiled.book.book_id ||
      marker.version_id !== previous.id ||
      (marker.compiler as { version: string }).version !==
        input.compiled.identity.compiler_version
    )
      return;
    const files = new Map(
      (marker.files as { path: string; sha256: string }[]).map((file) => [
        file.path,
        file.sha256,
      ]),
    );
    const verified = async (path: string) => {
      const expected = files.get(path);
      if (!expected) throw new Error("REUSE_FILE_MISSING");
      const bytes = await readFile(await resolveContainedPath(root, path));
      if (digest(bytes) !== expected) throw new Error("REUSE_FILE_CHANGED");
      return bytes.toString("utf8");
    };
    const book = validateBookDocument(
      JSON.parse(await verified("book.json")),
      input.compiled.book.book_id,
    );
    if (globalInputs(book) !== globalInputs(input.compiled.book)) return;
    const oldHeadings = new Map(
      presentDocumentHeadings(book).map((heading) => [
        heading.block_id,
        heading,
      ]),
    );
    const pages = new Map<string, { id: number; roots: ContentBlock[] }>();
    let roots: ContentBlock[] = [],
      pageId = 1;
    const finish = () => {
      if (roots[0]) pages.set(roots[0].id, { id: pageId++, roots });
      roots = [];
    };
    for (const block of book.blocks) {
      if (block.type === "heading" && block.starts_page && roots.length)
        finish();
      roots.push(block);
    }
    finish();
    const diagnostics = (
      JSON.parse(await verified("preview/diagnostics.json")) as {
        diagnostics: SafeDiagnostic[];
      }
    ).diagnostics;
    const warnings = diagnostics.filter((item) =>
      [
        "CODE_LANGUAGE_UNSUPPORTED",
        "MATH_RENDER_FAILED",
        "MERMAID_RENDER_INVALID",
      ].includes(item.code),
    );
    const resourceByUrl = new Map(
      book.resources.map((resource) => [
        "/books/" + book.book_id + "/assets/" + previous.id + "/" + resource.id,
        resource.id,
      ]),
    );
    const oldBookKey = book.alias ?? String(book.book_id);
    return async (options) => {
      try {
        const prior = pages.get(options.page.firstBlockId);
        const current = input.compiled.book.blocks.slice(
          options.page.rootRange.start,
          options.page.rootRange.end,
        );
        if (!prior || JSON.stringify(prior.roots) !== JSON.stringify(current))
          return null;
        const entries = [...contentEntries(current)],
          ids = new Set(entries.map((entry) => entry.node.id));
        if (
          hasFootnote(options.document.root) ||
          warnings.some((item) => !item.blockId || ids.has(item.blockId))
        )
          return null;
        for (const entry of entries) {
          if (entry.kind !== "heading") continue;
          const before = oldHeadings.get(entry.node.id),
            after = input.compiled.headingByBlockId.get(entry.node.id);
          if (
            !before ||
            !after ||
            before.number !== after.number ||
            before.display_level !== after.display_level ||
            before.title_markdown !== after.title_markdown
          )
            return null;
        }
        const tree = parse(
          await verified("published/pages/" + prior.id + ".html"),
        );
        const nodes = [...elements(tree)];
        const article = nodes.find(
          (node) =>
            node.tagName === "article" &&
            node.attrs.some(
              (attr) =>
                attr.name === "class" &&
                attr.value.split(/\s+/).includes("reader-document"),
            ),
        );
        const style = nodes.find((node) => node.tagName === "style");
        if (!article || !style) return null;
        for (const node of elements(article))
          for (const attr of node.attrs) {
            if (attr.name !== "href" && attr.name !== "src") continue;
            const resourceId = resourceByUrl.get(attr.value);
            if (resourceId) {
              attr.value = options.publishedResourceUrl(resourceId);
              continue;
            }
            if (
              attr.name === "href" &&
              attr.value.startsWith("/read/" + oldBookKey + "/")
            ) {
              const fragment = attr.value.split("#")[1];
              if (fragment && input.compiled.blockById.has(fragment))
                attr.value = options.blockHref(fragment);
            }
          }
        const css = style.childNodes
          .map((node) => ("value" in node ? node.value : ""))
          .join("");
        if (!css.startsWith(katexCriticalCss)) return null;
        return {
          html: serialize(article),
          css: css.slice(katexCriticalCss.length),
          diagnostics: [],
        };
      } catch {
        return null;
      }
    };
  } catch {
    return;
  }
}
