import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "@/schemas/book.schema.json" with { type: "json" };
import { SafeApplicationError } from "@/domain/errors";
import { hasControlCharacters } from "@/domain/text";
import type {
  BookDocument,
  ContentBlock,
  HeadingBlock,
  InlineNode,
  TableBlock,
} from "./book-document.generated";
import { contentEntries, inlineText, type ContentEntry } from "./content-tree";

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
export type DocumentHeader = Omit<BookDocument, "blocks">;
export type HeadingStructure = Pick<
  HeadingBlock,
  "id" | "level" | "starts_page" | "alias"
> & { readonly depth: number };
export interface ContentPosition {
  readonly rootOrdinal: number;
  readonly nodeOrdinal: number;
}
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
const validateHeaderSchema = validator.compile<DocumentHeader>({
  type: "object",
  additionalProperties: false,
  required: schema.required.filter((key) => key !== "blocks"),
  properties: Object.fromEntries(
    Object.entries(schema.properties).filter(([key]) => key !== "blocks"),
  ),
  $defs: schema.$defs,
});

function invalid(code = "BOOK_DOCUMENT_INVALID"): never {
  throw new SafeApplicationError(code, "The book document is invalid.", 400);
}
function inspectJson(input: unknown): void {
  const stack = [{ value: input, depth: 0 }],
    seen = new WeakSet<object>();
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
function headerResources(input: DocumentHeader): ReadonlySet<string> {
  const resources = new Set<string>(),
    paths = new Set<string>();
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
  return resources;
}
export function validateDocumentHeader(input: unknown): DocumentHeader {
  inspectJson(input);
  if (!validateHeaderSchema(input)) invalid();
  headerResources(input);
  return input;
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
function validateEntries(
  entries: readonly ContentEntry[],
  resources: ReadonlySet<string>,
  externalKind: (id: string) => string | null,
): void {
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
    kinds.set(node.id, kind);
    if (!("type" in node)) continue;
    if (node.type === "heading") {
      if (!inlineText(node.content).trim() || (node.starts_page && depth !== 0))
        invalid("BOOK_HEADING_INVALID");
      if (node.alias && !node.starts_page) invalid("BOOK_PAGE_ALIAS_INVALID");
    }
    if (node.type === "table") validateTable(node);
    if (node.type === "list" && !node.ordered && node.start !== undefined)
      invalid("BOOK_LIST_START_INVALID");
  }
  const kindOf = (id: string) => kinds.get(id) ?? externalKind(id);
  const checkInline = (nodes: readonly InlineNode[]): void => {
    for (const node of nodes) {
      if (node.type === "image" && !resources.has(node.resource_id))
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
  };
  for (const { node } of entries) {
    if (!("type" in node)) continue;
    if (node.type === "heading" || node.type === "paragraph")
      checkInline(node.content);
    if (node.type === "image" && !resources.has(node.resource_id))
      invalid("BOOK_RESOURCE_MISSING");
    if ("caption" in node) checkInline(node.caption ?? []);
  }
}
export function validateContentRoots(
  roots: readonly ContentBlock[],
  resources: ReadonlySet<string>,
  externalKind: (id: string) => string | null,
): void {
  for (const root of roots) {
    inspectJson(root);
    if (!validateBlockSchema(root)) invalid();
  }
  validateEntries([...contentEntries(roots)], resources, externalKind);
}
export function headingStructures(
  blocks: readonly ContentBlock[],
): HeadingStructure[] {
  return [...contentEntries(blocks)].flatMap(({ node, depth }) =>
    "type" in node && node.type === "heading"
      ? [
          {
            id: node.id,
            level: node.level,
            starts_page: node.starts_page,
            ...(node.alias ? { alias: node.alias } : {}),
            depth,
          },
        ]
      : [],
  );
}
export function validateHeadingSequence(
  headings: readonly HeadingStructure[],
): void {
  let level = 0;
  const aliases = new Set<string>();
  for (const heading of headings) {
    if (
      heading.level > level + 1 ||
      (heading.starts_page && heading.depth !== 0)
    )
      invalid("BOOK_HEADING_INVALID");
    level = heading.level;
    if (heading.alias) {
      if (!heading.starts_page || aliases.has(heading.alias))
        invalid("BOOK_PAGE_ALIAS_INVALID");
      aliases.add(heading.alias);
    }
  }
}
export function validateContentBoundaries(
  boundaries: BookDocument["publishing"]["boundaries"],
  positionOf: (id: string) => ContentPosition | null,
): void {
  let previous: ContentPosition | undefined;
  for (const id of [
    boundaries.body_start_block_id,
    boundaries.appendix_start_block_id,
    boundaries.backmatter_start_block_id,
  ]) {
    if (id === undefined) continue;
    const position = positionOf(id);
    if (
      !position ||
      (previous &&
        (position.rootOrdinal < previous.rootOrdinal ||
          (position.rootOrdinal === previous.rootOrdinal &&
            position.nodeOrdinal <= previous.nodeOrdinal)))
    )
      invalid("BOOK_BOUNDARY_INVALID");
    previous = position;
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
  if (input.blocks.length > contentLimits.topLevelBlocks)
    invalid("BOOK_DOCUMENT_LIMIT_EXCEEDED");
  const entries = [...contentEntries(input.blocks)];
  validateEntries(entries, headerResources(input), () => null);
  validateHeadingSequence(headingStructures(input.blocks));
  const positions = new Map(
    entries.map((entry, index) => [
      entry.node.id,
      { rootOrdinal: entry.rootIndex, nodeOrdinal: index },
    ]),
  );
  validateContentBoundaries(
    input.publishing.boundaries,
    (id) => positions.get(id) ?? null,
  );
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
  return (
    JSON.stringify({
      schema_version: book.schema_version,
      book_id: book.book_id,
      updated_at: book.updated_at,
      ...(book.alias ? { alias: book.alias } : {}),
      metadata: book.metadata,
      publishing: book.publishing,
      blocks: book.blocks,
      resources: book.resources,
    }) + "\n"
  );
}
export function equalJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        equalJson(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  );
}
