import { SafeApplicationError } from "@/domain/errors";
import type { ContentBlock } from "./book-document.generated";
import { contentEntries } from "./content-tree";
import {
  applyHeaderEdit,
  applyRootEdits,
  type DraftEdit,
  type BlockEdit,
} from "./edit-book";
import {
  contentLimits,
  equalJson,
  headingStructures,
  validateContentRoots,
  validateContentBoundaries,
  validateDocumentHeader,
  validateHeadingSequence,
  type DocumentHeader,
  type ContentPosition,
} from "./book-document";

export interface EditableRoot {
  readonly ordinal: number;
  readonly block: ContentBlock;
}
export interface IndexedContent {
  readonly kind: string;
  readonly rootId: string;
  readonly position: ContentPosition;
}
export interface EditContext {
  readonly header: DocumentHeader;
  rootForBlock(id: string): EditableRoot | null;
  node(id: string): IndexedContent | null;
  headingRoots(): readonly EditableRoot[];
  nodeCount(): number;
  referencesTo(
    ids: readonly string[],
    excludedRoots: readonly string[],
  ): readonly {
    readonly id: string;
    readonly field: "block_id" | "target_id";
  }[];
}
export interface PreparedEdit {
  readonly header: DocumentHeader;
  readonly roots: readonly EditableRoot[];
  readonly changed: boolean;
}

export function prepareDraftEdit(
  context: EditContext,
  patch: DraftEdit,
): PreparedEdit {
  const header = validateDocumentHeader(applyHeaderEdit(context.header, patch));
  const groups = new Map<string, { root: EditableRoot; edits: BlockEdit[] }>();
  for (const edit of patch.blocks ?? []) {
    const root = context.rootForBlock(edit.block_id);
    if (!root)
      throw new SafeApplicationError(
        "NOT_FOUND",
        "The draft block was not found.",
        404,
      );
    let group = groups.get(root.block.id);
    if (!group) {
      group = { root, edits: [] };
      groups.set(root.block.id, group);
    }
    group.edits.push(edit);
  }
  const changed = [...groups.values()].flatMap(({ root, edits }) => {
    const block = applyRootEdits(root.block, edits, header);
    return equalJson(root.block, block)
      ? []
      : [{ ordinal: root.ordinal, block, previous: root.block }];
  });
  const rootIds = new Set(changed.map((root) => root.block.id));
  const newNodes = new Map(
    changed.flatMap((root) =>
      [...contentEntries([root.block])].map(
        (entry, index) =>
          [
            entry.node.id,
            {
              kind: entry.kind,
              rootId: root.block.id,
              position: { rootOrdinal: root.ordinal, nodeOrdinal: index },
            },
          ] as const,
      ),
    ),
  );
  const previousNodes = changed.flatMap((root) => [
    ...contentEntries([root.previous]),
  ]);
  // Validate the final batch: replaced roots shadow their old identities and references.
  const lookup = (id: string) => {
    const indexed = context.node(id);
    return indexed && !rootIds.has(indexed.rootId) ? indexed : null;
  };
  if (changed.length) {
    validateContentRoots(
      changed.map((root) => root.block),
      new Set(header.resources.map((resource) => resource.id)),
      (id) => lookup(id)?.kind ?? null,
    );
    if (
      context.nodeCount() - previousNodes.length + newNodes.size >
      contentLimits.blocks
    )
      throw new SafeApplicationError(
        "BOOK_DOCUMENT_LIMIT_EXCEEDED",
        "The book exceeds the content limit.",
        400,
      );
    const invalidated = previousNodes.filter(
      (entry) =>
        !newNodes.has(entry.node.id) ||
        (entry.kind === "footnote" &&
          newNodes.get(entry.node.id)?.kind !== "footnote"),
    );
    if (invalidated.length) {
      const references = context.referencesTo(
        invalidated.map((entry) => entry.node.id),
        [...rootIds],
      );
      if (
        references.some((ref) =>
          ref.field === "target_id"
            ? newNodes.get(ref.id)?.kind !== "footnote"
            : !newNodes.has(ref.id),
        )
      )
        throw new SafeApplicationError(
          "BOOK_LINK_MISSING",
          "The edit would remove referenced content.",
          400,
        );
    }
    if (
      changed.some(
        (root) =>
          !equalJson(
            headingStructures([root.previous]),
            headingStructures([root.block]),
          ),
      )
    ) {
      const roots = new Map(
        context.headingRoots().map((root) => [root.block.id, root]),
      );
      for (const root of changed) roots.set(root.block.id, root);
      validateHeadingSequence(
        [...roots.values()]
          .sort((a, b) => a.ordinal - b.ordinal)
          .flatMap((root) => headingStructures([root.block])),
      );
    }
  }
  if (
    changed.length ||
    !equalJson(
      header.publishing.boundaries,
      context.header.publishing.boundaries,
    )
  )
    validateContentBoundaries(
      header.publishing.boundaries,
      (id) => newNodes.get(id)?.position ?? lookup(id)?.position ?? null,
    );
  return {
    header,
    roots: changed.map(({ ordinal, block }) => ({ ordinal, block })),
    changed: changed.length > 0 || !equalJson(header, context.header),
  };
}
