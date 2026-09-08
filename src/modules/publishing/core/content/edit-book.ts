import { SafeApplicationError } from "@/domain/errors";
import { isOpaqueId } from "@/domain/ids";
import type {
  BookDocument,
  BookMetadata,
  HeadingBlock,
  ListItem,
} from "./book-document.generated";
import { contentById } from "./content-tree";
import { parseBlockEditorText, parseInlineEditorText } from "./editor-text";
import { acceptBookChanges } from "./book-document";

export interface HeadingEdit {
  readonly block_id: string;
  readonly display_level?: number;
  readonly title_markdown?: string;
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
  readonly changes?: readonly HeadingEdit[];
  readonly block?: { readonly block_id: string; readonly markdown: string };
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
        ![
          "alias",
          "metadata",
          "numbering",
          "boundaries",
          "changes",
          "block",
        ].includes(key),
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
  if (patch.changes !== undefined) {
    if (!Array.isArray(patch.changes) || patch.changes.length > 20000)
      invalid();
    const ids = new Set<string>();
    for (const item of patch.changes) {
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
        if (key === "display_level") {
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
        } else if (key === "title_markdown") {
          if (typeof value !== "string" || !value.trim() || value.length > 2000)
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
  if (patch.block !== undefined) {
    const block = object(patch.block);
    if (
      Object.keys(block).length !== 2 ||
      typeof block.block_id !== "string" ||
      !isOpaqueId("block", block.block_id) ||
      typeof block.markdown !== "string" ||
      Buffer.byteLength(block.markdown) > 4 * 1024 * 1024
    )
      invalid();
  }
  return patch as DraftEdit;
}

export function editBookDocument(
  current: BookDocument,
  patch: DraftEdit,
  expectedUpdatedAt: number,
  nowMs: number,
): BookDocument {
  return acceptBookChanges(
    current,
    applyBookEdit(current, patch),
    expectedUpdatedAt,
    nowMs,
  );
}

export function applyBookEdit(
  current: BookDocument,
  patch: DraftEdit,
): BookDocument {
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
  const entries = contentById(next);
  for (const edit of patch.changes ?? []) {
    const entry = entries.get(edit.block_id);
    if (!entry || !("type" in entry.node) || entry.node.type !== "heading")
      invalid();
    const heading: HeadingBlock = entry.node;
    if (edit.display_level !== undefined) heading.level = edit.display_level;
    if (edit.title_markdown !== undefined)
      heading.content = parseInlineEditorText(edit.title_markdown, next);
    for (const key of [
      "include_in_toc",
      "starts_page",
      "exclude_from_numbering",
    ] as const)
      if (edit[key] !== undefined) heading[key] = edit[key];
    for (const key of ["source_number", "alias"] as const) {
      if (edit[key] === null) Reflect.deleteProperty(heading, key);
      else if (edit[key] !== undefined) heading[key] = edit[key];
    }
  }
  if (patch.block) {
    const entry = entries.get(patch.block.block_id);
    if (!entry || ("type" in entry.node && entry.node.type === "heading"))
      invalid();
    const previous = entry.node;
    if (!("type" in previous) || previous.type === "footnote") {
      const quoted = patch.block.markdown
        .split("\n")
        .map((line) => "> " + line)
        .join("\n");
      const replacement = parseBlockEditorText(quoted, next, {
        id: previous.id,
        type: "quote",
        content: previous.content,
      });
      if (replacement.type !== "quote") invalid();
      (previous as ListItem).content = replacement.content;
    } else {
      const replacement = parseBlockEditorText(
        patch.block.markdown,
        next,
        previous,
      );
      if (replacement !== previous) {
        for (const key of Object.keys(previous))
          Reflect.deleteProperty(previous, key);
        Object.assign(previous, replacement);
      }
    }
  }
  return next;
}
