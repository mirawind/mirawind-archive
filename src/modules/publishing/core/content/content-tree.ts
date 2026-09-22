import type {
  ContentBlock,
  InlineNode,
  ListItem,
} from "./book-document.generated";

export interface ContentEntry {
  readonly node: ContentBlock | ListItem;
  readonly kind: ContentBlock["type"] | "list_item";
  readonly rootIndex: number;
  readonly depth: number;
}

export function* contentEntries(
  blocks: readonly ContentBlock[],
): Generator<ContentEntry> {
  function* visit(
    node: ContentBlock | ListItem,
    rootIndex: number,
    depth: number,
  ): Generator<ContentEntry> {
    const kind = "type" in node ? node.type : "list_item";
    yield { node, kind, rootIndex, depth };
    if (
      !("type" in node) ||
      node.type === "quote" ||
      node.type === "footnote" ||
      node.type === "container"
    ) {
      for (const child of node.content)
        yield* visit(child, rootIndex, depth + 1);
    } else if (node.type === "list") {
      for (const item of node.items) yield* visit(item, rootIndex, depth + 1);
    } else if (node.type === "table") {
      for (const row of node.rows)
        for (const cell of row)
          for (const child of cell.content)
            yield* visit(child, rootIndex, depth + 1);
    }
    if ("notes" in node)
      for (const child of node.notes ?? [])
        yield* visit(child, rootIndex, depth + 1);
  }
  for (const [index, block] of blocks.entries()) yield* visit(block, index, 0);
}

export function inlineText(content: readonly InlineNode[]): string {
  return content
    .map((node) => {
      switch (node.type) {
        case "text":
          return node.text;
        case "code":
          return node.code;
        case "math":
          return node.latex;
        case "image":
          return node.alt;
        case "break":
          return "\n";
        case "footnote_reference":
          return "";
        default:
          return inlineText(node.content);
      }
    })
    .join("");
}

export function blockText(block: ContentBlock | ListItem): string {
  if (!("type" in block)) return block.content.map(blockText).join("\n");
  switch (block.type) {
    case "paragraph":
    case "heading":
      return inlineText(block.content);
    case "code":
      return [inlineText(block.caption ?? []), block.code]
        .filter(Boolean)
        .join("\n");
    case "math":
      return block.latex;
    case "image":
      return [
        block.alt,
        inlineText(block.caption ?? []),
        ...(block.notes ?? []).map(blockText),
      ]
        .filter(Boolean)
        .join("\n");
    case "list":
      return block.items.map(blockText).join("\n");
    case "table":
      return [
        inlineText(block.caption ?? []),
        ...block.rows.map((row) =>
          row.map((cell) => cell.content.map(blockText).join("\n")).join("\t"),
        ),
        ...(block.notes ?? []).map(blockText),
      ]
        .filter(Boolean)
        .join("\n");
    case "divider":
      return "";
    default:
      return block.content.map(blockText).join("\n");
  }
}
