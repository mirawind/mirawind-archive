import { Ajv2020 } from "ajv/dist/2020.js";

import schema from "@/schemas/book.schema.json" with { type: "json" };
import { SafeApplicationError } from "@/domain/errors";
import { hasControlCharacters } from "@/domain/text";
import type {
  BookDocument,
  ContentBlock,
  InlineNode,
  TableBlock,
} from "./book-document.generated";
import { contentEntries, inlineText } from "./content-tree";

export const contentLimits = Object.freeze({
  bytes: 256 * 1024 * 1024,
  topLevelBlocks: 20000,
  blocks: 100000,
  nodes: 1_000_000,
  depth: 128,
  blockDepth: 32,
  blockBytes: 4 * 1024 * 1024,
});
export const maximumContentTimestamp = 8_640_000_000_000_000;
const validator = new Ajv2020({
  strict: true,
  allErrors: false,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
});
const validateSchema = validator.compile<BookDocument>(schema);
const validateBlockSchema = validator.compile<ContentBlock>({
  $ref: schema.$id + "#/$defs/block",
});

// Heading edits need the ordered book context; ordinary roots can be checked in isolation.
export function validateEditedRoot(
  input: unknown,
  resourceIds: ReadonlySet<string>,
  externalKind: (id: string) => string | null,
): ContentBlock {
  inspectJson(input);
  if (!validateBlockSchema(input)) invalid();
  const entries = [...contentEntries([input])];
  if (entries.length > contentLimits.blocks)
    invalid("BOOK_DOCUMENT_LIMIT_EXCEEDED");
  const kinds = new Map<string, string>();
  for (const { node, kind, depth } of entries) {
    if (
      kinds.has(node.id) ||
      externalKind(node.id) !== null ||
      depth > contentLimits.blockDepth
    )
      invalid("BOOK_BLOCK_IDENTITY_INVALID");
    if (kind === "heading")
      invalid("BOOK_HEADING_REQUIRES_STRUCTURE_VALIDATION");
    kinds.set(node.id, kind);
    if ("type" in node && node.type === "table") validateTable(node);
    if (
      "type" in node &&
      node.type === "list" &&
      !node.ordered &&
      node.start !== undefined
    )
      invalid("BOOK_LIST_START_INVALID");
  }
  const kindOf = (id: string) => kinds.get(id) ?? externalKind(id);
  const inlines = (nodes: readonly InlineNode[]): void => {
    for (const node of nodes) {
      if (node.type === "image" && !resourceIds.has(node.resource_id))
        invalid("BOOK_RESOURCE_MISSING");
      if (
        node.type === "footnote_reference" &&
        kindOf(node.target_id) !== "footnote"
      )
        invalid("BOOK_FOOTNOTE_MISSING");
      if (node.type === "link") {
        if (
          node.target.type === "block" &&
          kindOf(node.target.block_id) === null
        )
          invalid("BOOK_LINK_MISSING");
        if (
          node.target.type === "resource" &&
          !resourceIds.has(node.target.resource_id)
        )
          invalid("BOOK_RESOURCE_MISSING");
        if (node.target.type === "external") {
          let url: URL;
          try {
            url = new URL(node.target.url);
          } catch {
            invalid("BOOK_LINK_INVALID");
          }
          if (!["https:", "http:", "mailto:"].includes(url.protocol))
            invalid("BOOK_LINK_INVALID");
        }
      }
      if ("content" in node) inlines(node.content);
    }
  };
  for (const { node } of entries) {
    if (!("type" in node)) continue;
    if (node.type === "paragraph") inlines(node.content);
    if (node.type === "image" && !resourceIds.has(node.resource_id))
      invalid("BOOK_RESOURCE_MISSING");
    if ("caption" in node) inlines(node.caption ?? []);
  }
  return input;
}

function invalid(code = "BOOK_DOCUMENT_INVALID"): never {
  throw new SafeApplicationError(code, "The book document is invalid.", 400);
}

function inspectJson(input: unknown): void {
  const stack = [{ value: input, depth: 0 }];
  const seen = new WeakSet<object>();
  let count = 0;
  while (stack.length) {
    const entry = stack.pop();
    if (!entry) break;
    if (++count > contentLimits.nodes || entry.depth > contentLimits.depth)
      invalid("BOOK_DOCUMENT_LIMIT_EXCEEDED");
    const value = entry.value;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      continue;
    if (typeof value === "number" && Number.isFinite(value)) continue;
    if (!value || typeof value !== "object" || seen.has(value)) invalid();
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype
    )
      invalid();
    seen.add(value);
    for (const child of Object.values(value))
      stack.push({ value: child, depth: entry.depth + 1 });
  }
}

function validateTable(table: TableBlock): void {
  const occupied: number[] = [];
  let width: number | undefined;
  for (const [rowIndex, row] of table.rows.entries()) {
    let column = 0;
    for (const cell of row) {
      while ((occupied[column] ?? 0) > rowIndex) column++;
      if (
        column + cell.col_span > 1000 ||
        rowIndex + cell.row_span > table.rows.length
      )
        invalid("BOOK_TABLE_SPAN_INVALID");
      for (let index = column; index < column + cell.col_span; index++) {
        if ((occupied[index] ?? 0) > rowIndex)
          invalid("BOOK_TABLE_SPAN_INVALID");
        occupied[index] = rowIndex + cell.row_span;
      }
      column += cell.col_span;
    }
    while ((occupied[column] ?? 0) > rowIndex) column++;
    width ??= column;
    if (column !== width) invalid("BOOK_TABLE_SHAPE_INVALID");
  }
}

export function validateBookDocument(
  input: unknown,
  expectedBookId?: number,
): BookDocument {
  inspectJson(input);
  if (!validateSchema(input)) invalid();
  if (expectedBookId !== undefined && input.book_id !== expectedBookId)
    invalid("BOOK_DOCUMENT_OWNER_MISMATCH");
  const entries = [...contentEntries(input.blocks)];
  if (
    input.blocks.length > contentLimits.topLevelBlocks ||
    entries.length > contentLimits.blocks
  )
    invalid("BOOK_DOCUMENT_LIMIT_EXCEEDED");
  const ids = new Set<string>();
  const resources = new Set<string>();
  const paths = new Set<string>();
  for (const resource of input.resources) {
    const components = resource.path.split("/");
    if (
      resources.has(resource.id) ||
      paths.has(resource.path) ||
      resource.path.includes("\\") ||
      /^[A-Za-z]:/u.test(resource.path) ||
      resource.path.normalize("NFC") !== resource.path ||
      hasControlCharacters(resource.path) ||
      components.some((part) => !part || part === "." || part === "..")
    )
      invalid("BOOK_RESOURCE_INVALID");
    resources.add(resource.id);
    paths.add(resource.path);
  }
  if (
    input.metadata.cover_resource_id &&
    !resources.has(input.metadata.cover_resource_id)
  )
    invalid("BOOK_RESOURCE_MISSING");
  const footnotes = new Set<string>();
  const aliases = new Set<string>();
  let previousLevel = 0;
  for (const { node, kind, depth } of entries) {
    if (ids.has(node.id) || depth > contentLimits.blockDepth)
      invalid("BOOK_BLOCK_IDENTITY_INVALID");
    ids.add(node.id);
    if (kind === "footnote") footnotes.add(node.id);
    if ("type" in node && node.type === "heading") {
      if (
        !inlineText(node.content).trim() ||
        node.level > previousLevel + 1 ||
        (node.starts_page && depth !== 0)
      )
        invalid("BOOK_HEADING_INVALID");
      previousLevel = node.level;
      if (node.alias) {
        if (!node.starts_page || aliases.has(node.alias))
          invalid("BOOK_PAGE_ALIAS_INVALID");
        aliases.add(node.alias);
      }
    }
    if ("type" in node && node.type === "table") validateTable(node);
    if (
      "type" in node &&
      node.type === "list" &&
      !node.ordered &&
      node.start !== undefined
    )
      invalid("BOOK_LIST_START_INVALID");
  }
  const indexes = new Map(
    entries.map((entry, index) => [entry.node.id, index]),
  );
  let boundaryIndex = -1;
  const boundaries = input.publishing.boundaries;
  for (const id of [
    boundaries.body_start_block_id,
    boundaries.appendix_start_block_id,
    boundaries.backmatter_start_block_id,
  ]) {
    if (id === undefined) continue;
    const index = indexes.get(id);
    if (index === undefined || index <= boundaryIndex)
      invalid("BOOK_BOUNDARY_INVALID");
    boundaryIndex = index;
  }
  function checkInline(nodes: readonly InlineNode[]): void {
    for (const node of nodes) {
      if (node.type === "image" && !resources.has(node.resource_id))
        invalid("BOOK_RESOURCE_MISSING");
      if (node.type === "footnote_reference" && !footnotes.has(node.target_id))
        invalid("BOOK_FOOTNOTE_MISSING");
      if (node.type === "link") {
        if (node.target.type === "block" && !ids.has(node.target.block_id))
          invalid("BOOK_LINK_MISSING");
        if (
          node.target.type === "resource" &&
          !resources.has(node.target.resource_id)
        )
          invalid("BOOK_RESOURCE_MISSING");
        if (node.target.type === "external") {
          let url: URL;
          try {
            url = new URL(node.target.url);
          } catch {
            invalid("BOOK_LINK_INVALID");
          }
          if (!["https:", "http:", "mailto:"].includes(url.protocol))
            invalid("BOOK_LINK_INVALID");
        }
      }
      if ("content" in node) checkInline(node.content);
    }
  }
  for (const { node } of entries) {
    if (!("type" in node)) continue;
    if (node.type === "heading" || node.type === "paragraph")
      checkInline(node.content);
    if (node.type === "image" && !resources.has(node.resource_id))
      invalid("BOOK_RESOURCE_MISSING");
    if ("caption" in node) checkInline(node.caption ?? []);
  }
  return input;
}

export function nextContentTimestamp(previous: number, now: number): number {
  if (
    !Number.isSafeInteger(previous) ||
    previous < 0 ||
    previous >= maximumContentTimestamp ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > maximumContentTimestamp
  )
    invalid("BOOK_TIMESTAMP_INVALID");
  return Math.max(now, previous + 1);
}

export function serializeBookDocument(book: BookDocument): string {
  return `${JSON.stringify({ schema_version: book.schema_version, book_id: book.book_id, updated_at: book.updated_at, ...(book.alias ? { alias: book.alias } : {}), metadata: book.metadata, publishing: book.publishing, blocks: book.blocks, resources: book.resources })}\n`;
}

function equalJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        equalJson(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  );
}

export function acceptBookChanges(
  current: BookDocument,
  proposed: BookDocument,
  expectedUpdatedAt: number,
  now: number,
): BookDocument {
  if (current.updated_at !== expectedUpdatedAt)
    throw new SafeApplicationError(
      "DRAFT_PRECONDITION_FAILED",
      "The draft changed since it was read.",
      412,
    );
  const next = validateBookDocument(
    { ...proposed, updated_at: current.updated_at },
    current.book_id,
  );
  if (equalJson(current, next)) return current;
  return { ...next, updated_at: nextContentTimestamp(current.updated_at, now) };
}

export function replaceContentBlock(
  book: BookDocument,
  blockId: string,
  replacement: ContentBlock,
): BookDocument {
  const next = structuredClone(book);
  const entry = [...contentEntries(next.blocks)].find(
    (value) => value.node.id === blockId,
  );
  if (!entry || !("type" in entry.node) || replacement.id !== blockId)
    invalid("BOOK_BLOCK_NOT_FOUND");
  for (const key of Object.keys(entry.node))
    Reflect.deleteProperty(entry.node, key);
  Object.assign(entry.node, replacement);
  return next;
}
