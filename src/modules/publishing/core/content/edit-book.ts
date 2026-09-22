import { SafeApplicationError } from "@/domain/errors";
import { isOpaqueId } from "@/domain/ids";
import type {
  BookDocument,
  BookMetadata,
  ContentBlock,
  ListItem,
} from "./book-document.generated";
import { contentEntries } from "./content-tree";
import { parseBlockEditorText, parseInlineEditorText } from "./editor-text";

export interface BlockEdit {
  readonly block_id: string;
  readonly level?: number;
  readonly markdown?: string;
  readonly source_number?: string | null;
  readonly include_in_toc?: boolean;
  readonly starts_page?: boolean;
  readonly exclude_from_numbering?: boolean;
  readonly alias?: string | null;
}
export interface DraftEdit {
  readonly alias?: string | null;
  readonly metadata?: Partial<{
    [Key in keyof BookMetadata]: BookMetadata[Key] | null;
  }>;
  readonly numbering?: BookDocument["publishing"]["numbering"];
  readonly boundaries?: {
    readonly body_start_block_id?: string;
    readonly appendix_start_block_id?: string | null;
    readonly backmatter_start_block_id?: string | null;
  };
  readonly blocks?: readonly BlockEdit[];
}
function invalid(): never {
  throw new SafeApplicationError(
    "DRAFT_PATCH_INVALID",
    "The draft edit is invalid.",
    400,
  );
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

export function parseDraftEdit(value: unknown): DraftEdit {
  const patch = object(value);
  if (
    Object.keys(patch).some(
      (key) =>
        !["alias", "metadata", "numbering", "boundaries", "blocks"].includes(
          key,
        ),
    )
  )
    invalid();
  if (
    patch.numbering !== undefined &&
    !["source", "generated", "none"].includes(String(patch.numbering))
  )
    invalid();
  if (
    patch.alias !== undefined &&
    patch.alias !== null &&
    (typeof patch.alias !== "string" || patch.alias.length > 120)
  )
    invalid();
  if (patch.metadata !== undefined) {
    const metadata = object(patch.metadata);
    if (
      Object.keys(metadata).some(
        (key) =>
          ![
            "title",
            "subtitle",
            "authors",
            "contributors",
            "description",
            "language",
            "publisher",
            "year",
            "edition",
            "isbn_10",
            "isbn_13",
            "cover_resource_id",
          ].includes(key),
      )
    )
      invalid();
    for (const [key, item] of Object.entries(metadata)) {
      if (item === null) {
        if (key === "title") invalid();
        continue;
      }
      if (key === "authors" || key === "contributors") {
        if (
          !Array.isArray(item) ||
          item.length > 100 ||
          item.some(
            (value) =>
              typeof value !== "string" || value.length > 200 || !value.trim(),
          )
        )
          invalid();
      } else if (key === "year") {
        if (
          !Number.isSafeInteger(item) ||
          Number(item) < 1 ||
          Number(item) > 9999
        )
          invalid();
      } else if (
        typeof item !== "string" ||
        item.length > 10000 ||
        (key === "title" && (!item.trim() || item.length > 500))
      )
        invalid();
    }
  }
  if (patch.boundaries !== undefined) {
    const values = object(patch.boundaries);
    for (const [key, id] of Object.entries(values)) {
      if (
        ![
          "body_start_block_id",
          "appendix_start_block_id",
          "backmatter_start_block_id",
        ].includes(key) ||
        (id === null
          ? key === "body_start_block_id"
          : typeof id !== "string" || !isOpaqueId("block", id))
      )
        invalid();
    }
  }
  if (patch.blocks !== undefined) {
    if (!Array.isArray(patch.blocks) || patch.blocks.length > 20000) invalid();
    const ids = new Set<string>();
    for (const item of patch.blocks) {
      const change = object(item);
      if (
        typeof change.block_id !== "string" ||
        !isOpaqueId("block", change.block_id) ||
        ids.has(change.block_id)
      )
        invalid();
      ids.add(change.block_id);
      for (const [key, value] of Object.entries(change)) {
        if (key === "block_id") continue;
        if (key === "level") {
          if (
            !Number.isSafeInteger(value) ||
            Number(value) < 1 ||
            Number(value) > 4
          )
            invalid();
        } else if (
          ["include_in_toc", "starts_page", "exclude_from_numbering"].includes(
            key,
          )
        ) {
          if (typeof value !== "boolean") invalid();
        } else if (key === "markdown") {
          if (
            typeof value !== "string" ||
            Buffer.byteLength(value) > 4 * 1024 * 1024
          )
            invalid();
        } else if (key === "source_number" || key === "alias") {
          if (
            value !== null &&
            (typeof value !== "string" || value.length > 120)
          )
            invalid();
        } else invalid();
      }
    }
  }
  return patch as DraftEdit;
}

export function applyHeaderEdit(
  current: Omit<BookDocument, "blocks">,
  patch: DraftEdit,
): Omit<BookDocument, "blocks"> {
  const next = structuredClone(current);
  if (patch.alias === null) delete next.alias;
  else if (patch.alias !== undefined) next.alias = patch.alias;
  for (const [key, value] of Object.entries(patch.metadata ?? {})) {
    if (value === null) Reflect.deleteProperty(next.metadata, key);
    else Reflect.set(next.metadata, key, value);
  }
  if (patch.numbering !== undefined)
    next.publishing.numbering = patch.numbering;
  for (const [key, value] of Object.entries(patch.boundaries ?? {})) {
    if (value === null) Reflect.deleteProperty(next.publishing.boundaries, key);
    else Reflect.set(next.publishing.boundaries, key, value);
  }
  return next;
}

export function applyRootEdits(
  root: ContentBlock,
  edits: readonly BlockEdit[],
  book: Pick<BookDocument, "resources">,
): ContentBlock {
  const next = structuredClone(root);
  const entries = new Map(
    [...contentEntries([next])].map((entry) => [entry.node.id, entry.node]),
  );
  const targets = new Set(edits.map((edit) => edit.block_id));
  for (const edit of edits) {
    const node = entries.get(edit.block_id);
    if (!node) invalid();
    const nested =
      "type" in node
        ? [...contentEntries([node])]
        : [...contentEntries(node.content)];
    if (
      nested.some(
        (entry) => entry.node.id !== node.id && targets.has(entry.node.id),
      )
    )
      throw new SafeApplicationError(
        "BLOCK_EDIT_OVERLAP",
        "A batch cannot edit both a container and its descendants.",
        400,
      );
  }
  for (const edit of edits) {
    const previous = entries.get(edit.block_id);
    if (!previous) invalid();
    const heading = "type" in previous && previous.type === "heading";
    if (
      !heading &&
      Object.keys(edit).some((key) => key !== "block_id" && key !== "markdown")
    )
      invalid();
    if (heading) {
      if (edit.markdown !== undefined) {
        if (!edit.markdown.trim() || edit.markdown.length > 2000) invalid();
        previous.content = parseInlineEditorText(edit.markdown, book);
      }
      for (const key of [
        "level",
        "include_in_toc",
        "starts_page",
        "exclude_from_numbering",
      ] as const)
        if (edit[key] !== undefined) Reflect.set(previous, key, edit[key]);
      for (const key of ["source_number", "alias"] as const) {
        if (edit[key] === null) Reflect.deleteProperty(previous, key);
        else if (edit[key] !== undefined) previous[key] = edit[key];
      }
      continue;
    }
    if (edit.markdown === undefined) continue;
    if (!("type" in previous) || previous.type === "footnote") {
      const quoted = edit.markdown
        .split("\n")
        .map((line) => "> " + line)
        .join("\n");
      const replacement = parseBlockEditorText(quoted, book, {
        id: previous.id,
        type: "quote",
        content: previous.content,
      });
      if (replacement.type !== "quote") invalid();
      (previous as ListItem).content = replacement.content;
    } else {
      const replacement = parseBlockEditorText(edit.markdown, book, previous);
      if (replacement !== previous) {
        for (const key of Object.keys(previous))
          Reflect.deleteProperty(previous, key);
        Object.assign(previous, replacement);
      }
    }
  }
  return next;
}
