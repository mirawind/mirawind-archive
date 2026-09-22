import { diffArrays } from "diff";
import { SafeApplicationError } from "@/domain/errors";
import type {
  ContentBlock,
  ListItem,
  TableCell,
} from "./book-document.generated";

function editableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      const next = editableValue(item) as Record<string, unknown> | null;
      const previous = result.at(-1) as Record<string, unknown> | undefined;
      if (next?.type === "text" && typeof next.text === "string") {
        if (!next.text) continue;
        if (previous?.type === "text" && typeof previous.text === "string") {
          previous.text += next.text;
          continue;
        }
      }
      result.push(next);
    }
    return result;
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (
    record.type === "paragraph" &&
    Array.isArray(record.content) &&
    record.content.length === 1 &&
    record.content[0]?.type === "image"
  )
    return editableValue(record.content[0]);
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => !["id", "caption", "notes"].includes(key))
      .map((key) => [key, editableValue(record[key])]),
  );
}

function align<T>(
  previous: readonly T[],
  next: readonly T[],
  merge: (old: T, current: T) => T,
): T[] {
  const changes = diffArrays(
    previous.map((value) => JSON.stringify(editableValue(value))),
    next.map((value) => JSON.stringify(editableValue(value))),
    { maxEditLength: 1024 },
  );
  if (!changes)
    throw new SafeApplicationError(
      "CONTENT_EDIT_STRUCTURE_LIMIT",
      "The edited container exceeds the structural edit limit.",
      400,
    );
  const result: T[] = [];
  let oldIndex = 0,
    newIndex = 0;
  let removed: T[] = [],
    added: T[] = [];
  const flush = () => {
    result.push(
      ...added.map((node, index) => {
        const old = removed[index];
        return old === undefined ? node : merge(old, node);
      }),
    );
    removed = [];
    added = [];
  };
  for (const change of changes) {
    const count = change.count;
    if (change.removed) {
      removed.push(...previous.slice(oldIndex, oldIndex + count));
      oldIndex += count;
    } else if (change.added) {
      added.push(...next.slice(newIndex, newIndex + count));
      newIndex += count;
    } else {
      flush();
      for (let offset = 0; offset < count; offset++) {
        const old = previous[oldIndex++],
          node = next[newIndex++];
        if (old === undefined || node === undefined)
          throw new Error("CONTENT_EDIT_ALIGNMENT_INVALID");
        result.push(merge(old, node));
      }
    }
  }
  flush();
  return result;
}

function retainItem(previous: ListItem, next: ListItem): ListItem {
  return {
    ...next,
    id: previous.id,
    content: align(previous.content, next.content, retainEditedBlock),
  };
}
function retainCell(previous: TableCell, next: TableCell): TableCell {
  return {
    ...next,
    content: align(previous.content, next.content, retainEditedBlock),
  };
}

export function retainEditedBlock(
  previous: ContentBlock,
  next: ContentBlock,
): ContentBlock {
  if (
    JSON.stringify(editableValue(previous)) ===
    JSON.stringify(editableValue(next))
  )
    return previous;
  if (
    previous.type === "paragraph" &&
    next.type === "image" &&
    previous.content.length === 1 &&
    previous.content[0]?.type === "image"
  )
    return {
      ...previous,
      content: [
        { type: "image", resource_id: next.resource_id, alt: next.alt },
      ],
    };
  if (previous.type !== next.type) {
    if (
      ("caption" in previous && previous.caption?.length) ||
      ("notes" in previous && previous.notes?.length)
    )
      throw new SafeApplicationError(
        "CONTENT_EDIT_UNSUPPORTED",
        "Changing this block type would discard its caption or notes.",
        400,
      );
    return { ...next, id: previous.id };
  }
  const result = { ...previous, ...next, id: previous.id } as ContentBlock;
  if (previous.type === "heading" && next.type === "heading")
    return { ...previous, content: next.content, level: next.level };
  if (previous.type === "list" && result.type === "list") {
    result.items = align(previous.items, result.items, retainItem);
    if (!result.ordered) delete result.start;
  }
  if (
    (previous.type === "quote" && result.type === "quote") ||
    (previous.type === "container" && result.type === "container") ||
    (previous.type === "footnote" && result.type === "footnote")
  )
    result.content = align(previous.content, result.content, retainEditedBlock);
  if (previous.type === "table" && result.type === "table")
    result.rows = align(previous.rows, result.rows, (old, row) =>
      align(old, row, retainCell),
    );
  return result;
}
