import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import manifestSchema from "@/schemas/document-manifest.schema.json" with { type: "json" };
import versionSchema from "@/schemas/version.schema.json" with { type: "json" };
import { SafeApplicationError } from "@/domain/errors";
import {
  requireSupportedDocumentManifestSchemaVersion,
  requireSupportedVersionMarkerSchemaVersion,
} from "./versioning-schema";

interface SchemaDiagnostic {
  readonly instancePath: string;
  readonly keyword: string;
}

class PublicationSchemaValidationError extends SafeApplicationError {
  readonly diagnostics: readonly SchemaDiagnostic[];

  constructor(
    code: "DOCUMENT_MANIFEST_INVALID" | "VERSION_MARKER_INVALID",
    message: string,
    errors: readonly ErrorObject[] | null | undefined,
  ) {
    super(code, message, 400);
    this.name = "PublicationSchemaValidationError";
    this.diagnostics = Object.freeze(
      (errors ?? []).slice(0, 100).map((error) =>
        Object.freeze({
          instancePath: error.instancePath.slice(0, 2_048),
          keyword: error.keyword.slice(0, 80),
        }),
      ),
    );
  }
}

class PublicationSemanticValidationError extends SafeApplicationError {
  readonly diagnostics: readonly string[];

  constructor(
    code:
      "DOCUMENT_MANIFEST_SEMANTIC_INVALID" | "VERSION_MARKER_SEMANTIC_INVALID",
    diagnostics: readonly string[],
  ) {
    super(
      code,
      code === "DOCUMENT_MANIFEST_SEMANTIC_INVALID"
        ? "The document manifest contains unresolved references."
        : "The version marker does not describe a closed canonical version.",
      400,
    );
    this.name = "PublicationSemanticValidationError";
    this.diagnostics = Object.freeze(diagnostics.slice(0, 100));
  }
}

const ajv = new Ajv2020({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
});
(addFormats as unknown as (instance: Ajv2020) => void)(ajv);
ajv.addKeyword({
  keyword: "x-semantic-validations",
  schemaType: "array",
  valid: true,
});
const validateManifestSchema = ajv.compile(manifestSchema);
const validateMarkerSchema = ajv.compile(versionSchema);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

export function validateDocumentManifest(
  input: unknown,
): Readonly<Record<string, unknown>> {
  const manifest = record(input);
  requireSupportedDocumentManifestSchemaVersion(manifest.schema_version);
  if (!validateManifestSchema(manifest)) {
    throw new PublicationSchemaValidationError(
      "DOCUMENT_MANIFEST_INVALID",
      "The document manifest does not match schema version 5.",
      validateManifestSchema.errors,
    );
  }
  const diagnostics: string[] = [];
  const blocks = manifest.blocks as Record<
    string,
    Readonly<Record<string, unknown>>
  >;
  const pages = manifest.pages as readonly Readonly<Record<string, unknown>>[];
  const resources = manifest.resources as Record<string, unknown>;
  const pageIds = new Set<number>();
  const ownedBlocks = new Set<string>();
  for (const page of pages) {
    const pageId = Number(page.page_id);
    if (pageIds.has(pageId)) diagnostics.push("PAGE_ID_DUPLICATE");
    pageIds.add(pageId);
    const blockIds = page.block_ids as readonly string[];
    if (blockIds[0] !== page.first_block_id) {
      diagnostics.push("PAGE_FIRST_BLOCK_MISMATCH");
    }
    for (const blockId of blockIds) {
      if (!blocks[blockId]) diagnostics.push("PAGE_BLOCK_MISSING");
      if (ownedBlocks.has(blockId)) diagnostics.push("BLOCK_OWNED_TWICE");
      ownedBlocks.add(blockId);
      if (Number(blocks[blockId]?.page_id) !== pageId) {
        diagnostics.push("BLOCK_PAGE_MISMATCH");
      }
    }
  }
  for (const [blockId, block] of Object.entries(blocks)) {
    if (!ownedBlocks.has(blockId)) diagnostics.push("BLOCK_WITHOUT_PAGE");
    for (const resourceId of block.resource_ids as readonly string[]) {
      if (!resources[resourceId]) diagnostics.push("BLOCK_RESOURCE_MISSING");
    }
  }
  for (const item of manifest.toc as readonly Readonly<
    Record<string, unknown>
  >[]) {
    const block = blocks[String(item.block_id)];
    if (
      !block ||
      block.kind !== "heading" ||
      Number(block.page_id) !== Number(item.page_id) ||
      !pageIds.has(Number(item.page_id))
    ) {
      diagnostics.push("TOC_REFERENCE_INVALID");
    }
  }
  if (diagnostics.length > 0) {
    throw new PublicationSemanticValidationError(
      "DOCUMENT_MANIFEST_SEMANTIC_INVALID",
      diagnostics,
    );
  }
  return freezeDeep(manifest);
}

export function validateVersionMarker(
  input: unknown,
): Readonly<Record<string, unknown>> {
  const marker = record(input);
  requireSupportedVersionMarkerSchemaVersion(marker.schema_version);
  if (!validateMarkerSchema(marker)) {
    throw new PublicationSchemaValidationError(
      "VERSION_MARKER_INVALID",
      "The version marker does not match schema version 5.",
      validateMarkerSchema.errors,
    );
  }
  const diagnostics: string[] = [];
  const files = marker.files as readonly Readonly<Record<string, unknown>>[];
  const shared = marker.shared_files as readonly { path: string }[];
  if (
    new Set(shared.map((file) => file.path)).size !== shared.length ||
    shared.some(
      (file) =>
        !/^assets\/[A-Za-z0-9_.-]+$|^originals\/file_[A-Za-z0-9_-]+$/.test(
          file.path,
        ),
    )
  )
    diagnostics.push("VERSION_SHARED_RESOURCE_INVALID");
  const paths = files.map((file) => String(file.path));
  if (new Set(paths).size !== paths.length) {
    diagnostics.push("VERSION_FILE_PATH_DUPLICATE");
  }
  const sorted = [...paths].sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
  if (paths.some((path, index) => path !== sorted[index])) {
    diagnostics.push("VERSION_FILE_ORDER_INVALID");
  }
  const byPath = new Map(files.map((file) => [String(file.path), file]));
  if (
    byPath.get("book.json")?.sha256 !== marker.book_document_sha256 ||
    byPath.get("document-manifest.json")?.sha256 !== marker.manifest_sha256
  ) {
    diagnostics.push("VERSION_AUTHORITY_HASH_MISMATCH");
  }
  if (diagnostics.length > 0) {
    throw new PublicationSemanticValidationError(
      "VERSION_MARKER_SEMANTIC_INVALID",
      diagnostics,
    );
  }
  return freezeDeep(marker);
}
