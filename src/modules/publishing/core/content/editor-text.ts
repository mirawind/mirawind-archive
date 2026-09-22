import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

import { createOpaqueId } from "@/domain/ids";
import { SafeApplicationError } from "@/domain/errors";
import type {
  BookDocument,
  ContentBlock,
  InlineNode,
  ListItem,
} from "./book-document.generated";
import { renderingInline } from "./rendering-document";
import { retainEditedBlock } from "./edit-identities";
import { inlineHtml, parseInlineHtml } from "./inline-html";
import { parseTableHtml, tableEditorHtml } from "./table-html";
import { parseEditorDocument } from "./editor-parser";
import type { TransientDocumentNode } from "../preparation/document-model";

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkStringify, { bullet: "-", fences: true });
type Root = ReturnType<typeof processor.parse>;
function unsupported(): never {
  throw new SafeApplicationError(
    "CONTENT_EDIT_UNSUPPORTED",
    "This edit contains unsupported content.",
    400,
  );
}

export function inlineEditorText(
  content: readonly InlineNode[],
  book: Pick<BookDocument, "resources"> = { resources: [] },
): string {
  const children = editorInlines(content, book);
  return processor
    .stringify({
      type: "root",
      children: [{ type: "paragraph", children }],
    } as unknown as Root)
    .trimEnd();
}

function editorInlines(
  content: readonly InlineNode[],
  book: Pick<BookDocument, "resources">,
): TransientDocumentNode[] {
  return content.flatMap((node) => {
    if (
      ["subscript", "superscript", "underline", "footnote_reference"].includes(
        node.type,
      )
    )
      return [{ type: "html", value: inlineHtml([node], book) }];
    const rendered = renderingInline([node], book)[0];
    if (!rendered) unsupported();
    return [
      {
        ...rendered,
        ...("content" in node
          ? { children: editorInlines(node.content, book) }
          : {}),
      },
    ];
  });
}

export function parseInlineEditorText(
  value: string,
  book: Pick<BookDocument, "resources">,
): InlineNode[] {
  const tree = processor.parse(value) as unknown as TransientDocumentNode;
  if (
    (tree.children?.length ?? 0) !== 1 ||
    tree.children?.[0]?.type !== "paragraph"
  )
    unsupported();
  return inlineFromEditor(tree.children[0].children ?? [], book);
}

function inlineFromEditor(
  nodes: readonly TransientDocumentNode[],
  book: Pick<BookDocument, "resources">,
): InlineNode[] {
  if (nodes.some((node) => node.type === "html"))
    return parseInlineHtml(
      nodes
        .map((node) =>
          node.type === "html"
            ? (node.value ?? "")
            : inlineHtml(inlineFromEditor([node], book), book),
        )
        .join(""),
      book,
    );
  return nodes.map((node) => {
    switch (node.type) {
      case "text":
        return { type: "text", text: node.value ?? "" };
      case "inlineCode":
        return { type: "code", code: node.value ?? "" };
      case "inlineMath":
        return { type: "math", latex: node.value ?? "" };
      case "break":
        return { type: "break" };
      case "footnoteReference":
        return { type: "footnote_reference", target_id: node.identifier ?? "" };
      case "emphasis":
      case "strong":
      case "delete":
        return {
          type: node.type,
          content: inlineFromEditor(node.children ?? [], book),
        };
      case "image": {
        const resource = book.resources.find((item) => item.path === node.url);
        if (!resource) unsupported();
        return { type: "image", resource_id: resource.id, alt: node.alt ?? "" };
      }
      case "link": {
        const url = node.url ?? "";
        const content = inlineFromEditor(node.children ?? [], book);
        if (url.startsWith("#blk_"))
          return {
            type: "link",
            target: { type: "block", block_id: url.slice(1) },
            content,
          };
        const resource = book.resources.find((item) => item.path === url);
        if (resource)
          return {
            type: "link",
            target: { type: "resource", resource_id: resource.id },
            content,
          };
        if (/^(?:https?:|mailto:)/iu.test(url))
          return { type: "link", target: { type: "external", url }, content };
        return unsupported();
      }
      default:
        unsupported();
    }
  });
}

export function parseBlockEditorText(
  value: string,
  book: Pick<BookDocument, "resources">,
  previous: ContentBlock,
): ContentBlock {
  if (Buffer.byteLength(value) > 4 * 1024 * 1024) unsupported();
  if (value === blockEditorText(previous, book)) return previous;
  if (previous.type === "paragraph" && !value.trim())
    return { ...previous, content: [] };
  if (previous.type === "table") {
    return retainEditedBlock(previous, {
      ...previous,
      rows: parseTableHtml(value, (path) => {
        const resource = book.resources.find((item) => item.path === path);
        if (!resource) unsupported();
        return resource.id;
      }),
    });
  }
  const tree = value.includes(":::")
    ? parseEditorDocument(value).root
    : (processor.parse(value) as unknown as TransientDocumentNode);
  const nodes = tree.children ?? [];
  const node = nodes[0];
  if (nodes.length !== 1 || !node || node.type === "heading") unsupported();
  function convert(node: TransientDocumentNode): ContentBlock {
    const id = createOpaqueId("block");
    switch (node.type) {
      case "heading":
        return {
          id,
          type: "heading",
          level: node.depth ?? 1,
          content: inlineFromEditor(node.children ?? [], book),
          include_in_toc: true,
          starts_page: false,
          exclude_from_numbering: false,
        };
      case "paragraph": {
        const content = inlineFromEditor(node.children ?? [], book);
        const image = content.length === 1 ? content[0] : undefined;
        if (image?.type === "image")
          return {
            id,
            type: "image",
            resource_id: image.resource_id,
            alt: image.alt,
          };
        return { id, type: "paragraph", content };
      }
      case "code":
        return {
          id,
          type: "code",
          language: node.lang ?? "text",
          code: node.value ?? "",
        };
      case "math":
        return { id, type: "math", latex: node.value ?? "" };
      case "html":
        return {
          id,
          type: "table",
          rows: parseTableHtml(node.value ?? "", (path) => {
            const resource = book.resources.find((item) => item.path === path);
            if (!resource) unsupported();
            return resource.id;
          }),
        };
      case "table":
        return {
          id,
          type: "table",
          rows: (node.children ?? []).map((row, index) =>
            (row.children ?? []).map((cell, column) => {
              const align = node.align?.[column];
              return {
                header: index === 0,
                row_span: 1,
                col_span: 1,
                ...(align ? { align } : {}),
                content: [
                  {
                    id: createOpaqueId("block"),
                    type: "paragraph" as const,
                    content: inlineFromEditor(cell.children ?? [], book),
                  },
                ],
              };
            }),
          ),
        };
      case "blockquote":
        return {
          id,
          type: "quote",
          content: (node.children ?? []).map(convert),
        };
      case "semanticContainer":
        return {
          id,
          type: "container",
          kind: node.containerKind ?? "note",
          content: (node.children ?? []).map(convert),
        };
      case "list":
        return {
          id,
          type: "list",
          ordered: node.ordered ?? false,
          ...(node.ordered ? { start: node.start ?? 1 } : {}),
          items: (node.children ?? []).map((item) => ({
            id: createOpaqueId("block"),
            content: (item.children ?? []).map(convert),
            ...(typeof item.checked === "boolean"
              ? { checked: item.checked }
              : {}),
          })),
        };
      case "thematicBreak":
        return { id, type: "divider" };
      default:
        return unsupported();
    }
  }
  return retainEditedBlock(previous, convert(node));
}

export function blockEditorText(
  block: ContentBlock | ListItem,
  book: Pick<BookDocument, "resources">,
): string {
  const nestedText = (children: readonly ContentBlock[]) =>
    children
      .map((child) =>
        child.type === "heading"
          ? "#".repeat(child.level) +
            " " +
            inlineEditorText(child.content, book)
          : blockEditorText(child, book),
      )
      .join("\n\n");
  if (!("type" in block)) return nestedText(block.content);
  if (block.type === "heading" || block.type === "paragraph")
    return inlineEditorText(block.content, book);
  if (block.type === "table") return tableEditorHtml(block, book);
  if (block.type === "container")
    return ":::" + block.kind + "\n" + nestedText(block.content) + "\n:::";
  if (block.type === "footnote") return nestedText(block.content);
  function node(value: ContentBlock): TransientDocumentNode {
    switch (value.type) {
      case "heading":
        return {
          type: "heading",
          depth: value.level,
          children: editorInlines(value.content, book),
        };
      case "paragraph":
        return {
          type: "paragraph",
          children: editorInlines(value.content, book),
        };
      case "code":
        return { type: "code", lang: value.language, value: value.code };
      case "math":
        return { type: "math", value: value.latex };
      case "image":
        return {
          type: "paragraph",
          children: [
            {
              type: "image",
              url:
                book.resources.find(
                  (resource) => resource.id === value.resource_id,
                )?.path ?? "",
              alt: value.alt,
            },
          ],
        };
      case "quote":
        return { type: "blockquote", children: value.content.map(node) };
      case "list":
        return {
          type: "list",
          ordered: value.ordered,
          ...(value.start !== undefined ? { start: value.start } : {}),
          children: value.items.map((item) => ({
            type: "listItem",
            ...(item.checked !== undefined ? { checked: item.checked } : {}),
            children: item.content.map(node),
          })),
        };
      case "divider":
        return { type: "thematicBreak" };
      default:
        return { type: "html", value: blockEditorText(value, book) };
    }
  }
  return processor
    .stringify({ type: "root", children: [node(block)] } as unknown as Root)
    .trimEnd();
}
