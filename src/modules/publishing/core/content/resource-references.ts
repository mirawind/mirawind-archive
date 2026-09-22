import type { ContentBlock, InlineNode } from "./book-document.generated";
import { contentEntries } from "./content-tree";

export function contentResourceIds(blocks: readonly ContentBlock[]): string[] {
  const ids = new Set<string>();
  function inline(nodes: readonly InlineNode[]): void {
    for (const node of nodes) {
      if (node.type === "image") ids.add(node.resource_id);
      if (node.type === "link" && node.target.type === "resource")
        ids.add(node.target.resource_id);
      if ("content" in node) inline(node.content);
    }
  }
  for (const { node } of contentEntries(blocks)) {
    if (!("type" in node)) continue;
    if (node.type === "image") ids.add(node.resource_id);
    if (node.type === "heading" || node.type === "paragraph")
      inline(node.content);
    if ("caption" in node) inline(node.caption ?? []);
  }
  return [...ids].sort();
}
