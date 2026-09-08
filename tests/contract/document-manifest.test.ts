import { describe, expect, it } from "vitest";

import {
  validateDocumentManifest,
  validateVersionMarker,
} from "@/modules/publishing/core/publication/document-manifest-schema";

const blockId = "blk_0123456789abcdefghij";
const resourceId = "res_0123456789abcdefghij";
const versionId = "ver_0123456789abcdefghij";

function manifest(): Record<string, unknown> {
  return {
    blocks: {
      [blockId]: {
        kind: "heading",
        normalized_visible_text: "Chapter",
        page_id: 1,
        resource_ids: [resourceId],
      },
    },
    book_id: 1,
    compiler: {
      name: "mirawind-book-compiler",
      renderer_version: "semantic-html-v8-katex-0.18.1",
      text_normalization_version: 1,
      version: "compiler-v8",
    },
    source_updated_at: 2000,
    created_at: "2026-07-24T00:00:00.000Z",
    pages: [
      {
        block_ids: [blockId],
        first_block_id: blockId,
        output_path: "published/pages/1.html",
        page_id: 1,
        title: "Chapter",
      },
    ],
    resources: {
      [resourceId]: {
        height: 10,
        media_type: "image/png",
        output_path: `published/assets/${resourceId}`,
        sha256: "b".repeat(64),
        size: 100,
        source_path: "source/image.png",
        width: 10,
      },
    },
    schema_version: 5,
    toc: [
      {
        block_id: blockId,
        level: 1,
        number: "1",
        page_id: 1,
        role: "body",
        title: "Chapter",
      },
    ],
    version_id: versionId,
  };
}

function versionMarker(): Record<string, unknown> {
  return {
    book_id: 1,
    book_document_sha256: "d".repeat(64),
    complete: true,
    shared_files: [],
    compiler: {
      name: "mirawind-book-compiler",
      renderer_version: "semantic-html-v8-katex-0.18.1",
      text_normalization_version: 1,
      version: "compiler-v8",
    },
    source_updated_at: 2000,
    created_at: "2026-07-24T00:00:00.000Z",
    files: [
      { path: "book.json", sha256: "d".repeat(64), size: 10 },
      {
        path: "document-manifest.json",
        sha256: "e".repeat(64),
        size: 20,
      },
      {
        path: "published/pages/1.html",
        sha256: "f".repeat(64),
        size: 30,
      },
    ],
    manifest_sha256: "e".repeat(64),
    predecessor_version_id: null,
    schema_version: 5,
    version_id: versionId,
  };
}

describe("document manifest and immutable version marker", () => {
  it("accepts a strict manifest with stable IDs, hashes, spans and closed references", () => {
    const result = validateDocumentManifest(manifest());
    expect(result).toMatchObject({
      book_id: 1,
      schema_version: 5,
      version_id: versionId,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects unresolved page, TOC and resource references", () => {
    const missingBlock = manifest();
    (missingBlock.pages as Record<string, unknown>[])[0] = {
      ...(missingBlock.pages as Record<string, unknown>[])[0],
      block_ids: ["blk_missing0123456789abc"],
      first_block_id: "blk_missing0123456789abc",
    };
    expect(() => validateDocumentManifest(missingBlock)).toThrow(
      expect.objectContaining({ code: "DOCUMENT_MANIFEST_SEMANTIC_INVALID" }),
    );

    const missingResource = manifest();
    (missingResource.blocks as Record<string, Record<string, unknown>>)[
      blockId
    ] = {
      ...(missingResource.blocks as Record<string, Record<string, unknown>>)[
        blockId
      ],
      resource_ids: ["res_missing0123456789abc"],
    };
    expect(() => validateDocumentManifest(missingResource)).toThrow(
      expect.objectContaining({ code: "DOCUMENT_MANIFEST_SEMANTIC_INVALID" }),
    );
  });

  it("rejects duplicate page ownership", () => {
    const duplicate = manifest();
    (duplicate.pages as Record<string, unknown>[]).push({
      block_ids: [blockId],
      first_block_id: blockId,
      output_path: "published/pages/2.html",
      page_id: 2,
      title: "Duplicate",
    });
    expect(() => validateDocumentManifest(duplicate)).toThrow(
      expect.objectContaining({ code: "DOCUMENT_MANIFEST_SEMANTIC_INVALID" }),
    );
  });

  it("requires a strict complete marker and canonical closed file list", () => {
    expect(validateVersionMarker(versionMarker())).toMatchObject({
      complete: true,
      schema_version: 5,
    });

    expect(() =>
      validateVersionMarker({ ...versionMarker(), complete: false }),
    ).toThrow(expect.objectContaining({ code: "VERSION_MARKER_INVALID" }));
    expect(() =>
      validateVersionMarker({
        ...versionMarker(),
        files: [
          ...(versionMarker().files as Record<string, unknown>[]),
          { path: "book.json", sha256: "d".repeat(64), size: 10 },
        ],
      }),
    ).toThrow(
      expect.objectContaining({ code: "VERSION_MARKER_SEMANTIC_INVALID" }),
    );
    expect(() =>
      validateVersionMarker({
        ...versionMarker(),
        files: [
          {
            path: "document-manifest.json",
            sha256: "e".repeat(64),
            size: 20,
          },
          { path: "book.json", sha256: "d".repeat(64), size: 10 },
          {
            path: "published/pages/1.html",
            sha256: "f".repeat(64),
            size: 30,
          },
        ],
      }),
    ).toThrow(
      expect.objectContaining({ code: "VERSION_MARKER_SEMANTIC_INVALID" }),
    );
  });

  it("rejects unknown fields and unsupported newer schema versions", () => {
    expect(() =>
      validateDocumentManifest({ ...manifest(), private_notes: true }),
    ).toThrow(expect.objectContaining({ code: "DOCUMENT_MANIFEST_INVALID" }));
    expect(() =>
      validateDocumentManifest({ ...manifest(), schema_version: 2 }),
    ).toThrow(
      expect.objectContaining({
        code: "DOCUMENT_MANIFEST_SCHEMA_VERSION_UNSUPPORTED",
      }),
    );
    expect(() =>
      validateDocumentManifest({ ...manifest(), schema_version: 6 }),
    ).toThrow(
      expect.objectContaining({
        code: "DOCUMENT_MANIFEST_SCHEMA_VERSION_UNSUPPORTED",
      }),
    );
    expect(() =>
      validateVersionMarker({ ...versionMarker(), schema_version: 2 }),
    ).toThrow(
      expect.objectContaining({
        code: "VERSION_MARKER_SCHEMA_VERSION_UNSUPPORTED",
      }),
    );
    expect(() =>
      validateVersionMarker({ ...versionMarker(), schema_version: 6 }),
    ).toThrow(
      expect.objectContaining({
        code: "VERSION_MARKER_SCHEMA_VERSION_UNSUPPORTED",
      }),
    );
  });
});
