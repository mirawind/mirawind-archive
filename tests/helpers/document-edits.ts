import type { BookDocument } from "@/modules/publishing/core/content/book-document.generated";
import { contentEntries } from "@/modules/publishing/core/content/content-tree";
import { nextContentTimestamp } from "@/modules/publishing/core/content/book-document";
import { parseDraftEdit } from "@/modules/publishing/core/content/edit-book";
import {
  prepareDraftEdit,
  type EditContext,
} from "@/modules/publishing/core/content/prepare-edit";
import { required } from "./required";

export function editContextForBook(book: BookDocument): EditContext {
  const { blocks, ...header } = book;
  const entries = [...contentEntries(blocks)];
  const nodes = new Map(
    entries.map((entry, index) => [
      entry.node.id,
      {
        kind: entry.kind,
        rootId: required(blocks[entry.rootIndex]).id,
        position: { rootOrdinal: entry.rootIndex, nodeOrdinal: index },
      },
    ]),
  );
  return {
    header,
    rootForBlock(id) {
      const node = nodes.get(id);
      return node
        ? {
            ordinal: node.position.rootOrdinal,
            block: required(blocks[node.position.rootOrdinal]),
          }
        : null;
    },
    node: (id) => nodes.get(id) ?? null,
    headingRoots: () =>
      blocks.flatMap((block, ordinal) =>
        [...contentEntries([block])].some((entry) => entry.kind === "heading")
          ? [{ ordinal, block }]
          : [],
      ),
    nodeCount: () => nodes.size,
    referencesTo(ids, excludedRoots) {
      const found: { id: string; field: "block_id" | "target_id" }[] = [];
      function visit(value: unknown) {
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          if (
            (key === "block_id" || key === "target_id") &&
            typeof child === "string" &&
            ids.includes(child)
          )
            found.push({ id: child, field: key });
          else visit(child);
        }
      }
      for (const block of blocks)
        if (!excludedRoots.includes(block.id)) visit(block);
      return found;
    },
  };
}

export function editDraftInMemory(
  book: BookDocument,
  patch: unknown,
  expected: number,
  now: number,
): BookDocument {
  if (book.updated_at !== expected)
    throw new Error("DRAFT_PRECONDITION_FAILED");
  const prepared = prepareDraftEdit(
    editContextForBook(book),
    parseDraftEdit(patch),
  );
  const changed = new Map(
    prepared.roots.map((root) => [root.block.id, root.block]),
  );
  return {
    ...prepared.header,
    updated_at: prepared.changed
      ? nextContentTimestamp(expected, now)
      : expected,
    blocks: book.blocks.map((block) => changed.get(block.id) ?? block),
  };
}
