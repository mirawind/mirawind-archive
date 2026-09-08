import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { compileBook } from "../../core/publication/compile-book";
import {
  validateBookDocument,
  serializeBookDocument,
} from "../../core/content/book-document";
import type { BookDocument } from "../../core/content/book-document.generated";
import {
  buildDocumentManifest,
  canonicalJson,
  compilerIdentity,
  type ManifestResource,
} from "../../core/publication/manifest";
import { inspectRasterImage } from "../../core/publication/inspect-image";
import type { CompiledBook } from "../../core/publication/compiled-book";
import type { ResourceResolution } from "../../core/publication/resource-model";
import type { SemanticCompilationIdentity } from "../../core/preparation/document-model";
import { validateVersionMarker } from "../../core/publication/document-manifest-schema";
import { resolveContainedPath } from "@/platform/filesystem/contained-path";
import { readJsonDocument } from "./read-json-document";
import {
  createBuildFileInventory,
  type BuildFileInventory,
} from "./build-file-inventory";

export interface BuildAssemblyArtifact {
  readonly bookId: number;
  readonly sourceUpdatedAt: number;
  readonly identity: SemanticCompilationIdentity;
  readonly manifestSha256: string;
  readonly versionDirectory: "version";
  readonly versionId: string;
}
export interface BuildAssemblyResult extends BuildAssemblyArtifact {
  readonly pageMaterialization: unknown;
}
export interface BuildPageMaterializationContext {
  readonly bookId: number;
  readonly buildDirectory: string;
  readonly compiled: CompiledBook;
  readonly bookDocument: BookDocument;
  readonly sourceUpdatedAt: number;
  readonly files: BuildFileInventory;
  readonly originalFiles: readonly Readonly<Record<string, unknown>>[];
  readonly resourceResolution: ResourceResolution;
  readonly versionId: string;
}
export interface AssembleBuildInput {
  readonly bookId: number;
  readonly sourceUpdatedAt: number;
  readonly inputPath: string;
  readonly importId: string;
  readonly resourceRoot: string;
  readonly createdAtMs: number;
  readonly predecessorVersionId: string | null;
  readonly documentSha256: string;
  readonly materializePages: (
    input: BuildPageMaterializationContext,
  ) => Promise<unknown>;
  readonly signal?: AbortSignal;
  readonly stagingDirectory: string;
  readonly versionId: string;
}
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export async function assembleBuild(
  input: AssembleBuildInput,
): Promise<BuildAssemblyResult> {
  const staging = resolve(input.stagingDirectory);
  const versionDirectory = resolve(staging, "version");
  const files = createBuildFileInventory(versionDirectory);
  try {
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await mkdir(versionDirectory, { mode: 0o700 });
    input.signal?.throwIfAborted();
    const book = validateBookDocument(
      await readJsonDocument(input.inputPath, input.signal),
      input.bookId,
    );
    if (book.updated_at !== input.sourceUpdatedAt)
      throw new Error("BUILD_INPUT_STALE");
    const documentJson = serializeBookDocument(book);
    if (sha256(documentJson) !== input.documentSha256)
      throw new Error("BUILD_DOCUMENT_INTEGRITY_MISMATCH");
    const compiled = compileBook(book);
    await files.write("book.json", documentJson);
    const originalRecord = JSON.parse(
      await readFile(
        resolve(dirname(input.inputPath), "original.json"),
        "utf8",
      ),
    ) as { import_id: string; files: Readonly<Record<string, unknown>>[] };
    if (
      originalRecord.import_id !== input.importId ||
      !Array.isArray(originalRecord.files) ||
      originalRecord.files.length !== 1
    )
      throw new Error("BUILD_ORIGINAL_CAPTURE_INVALID");
    const sharedFiles: { path: string; sha256: string; size: number }[] = [];
    for (const original of originalRecord.files) {
      input.signal?.throwIfAborted();
      const relativePath = "originals/" + original.id;
      if (original.path !== "books/" + input.bookId + "/" + relativePath)
        throw new Error("BUILD_ORIGINAL_PATH_INVALID");
      const originalPath = await resolveContainedPath(
        input.resourceRoot,
        relativePath,
      );
      const metadata = await lstat(originalPath);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size !== original.size
      )
        throw new Error("BUILD_ORIGINAL_INVALID");
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of createReadStream(originalPath)) {
        input.signal?.throwIfAborted();
        size += chunk.byteLength;
        if (size > Number(original.size))
          throw new Error("BUILD_ORIGINAL_CHANGED");
        hash.update(chunk);
      }
      const digest = hash.digest("hex");
      if (size !== original.size || digest !== original.sha256)
        throw new Error("BUILD_ORIGINAL_CHANGED");
      sharedFiles.push({ path: relativePath, sha256: digest, size });
    }
    const resources: ManifestResource[] = [];
    const resourceProof = JSON.parse(
      await readFile(
        resolve(dirname(input.inputPath), "resources.json"),
        "utf8",
      ),
    ) as { id: string; sha256: string; size: number }[];
    const proofById = new Map(resourceProof.map((value) => [value.id, value]));
    for (const resource of book.resources) {
      input.signal?.throwIfAborted();
      const absolutePath = await resolveContainedPath(
        input.resourceRoot,
        resource.path,
      );
      const metadata = await lstat(absolutePath);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size > 2 * 1024 * 1024 * 1024
      )
        throw new Error("BUILD_RESOURCE_INVALID");
      const bytes = await readFile(absolutePath);
      const proof = proofById.get(resource.id);
      if (
        !proof ||
        proof.size !== bytes.byteLength ||
        proof.sha256 !== sha256(bytes)
      )
        throw new Error("BUILD_RESOURCE_INTEGRITY_MISMATCH");
      const image = await inspectRasterImage({
        bytes,
        filename: resource.path,
      });
      const outputPath = resource.path;
      sharedFiles.push({
        path: resource.path,
        size: bytes.byteLength,
        sha256: proof.sha256,
      });
      resources.push({
        id: resource.id,
        absolutePath,
        relativePath: resource.path,
        originalUrl: resource.path,
        mediaType: "image/" + image.format,
        height: image.height,
        width: image.width,
        size: bytes.byteLength,
        sha256: sha256(bytes),
        outputPath,
      });
    }
    const resolution: ResourceResolution = {
      resources,
      references: resources.map((resource) => ({
        resourceId: resource.id,
        originalUrl: resource.originalUrl,
      })),
      diagnostics: [],
    };
    const pageMaterialization = await input.materializePages({
      bookId: input.bookId,
      buildDirectory: versionDirectory,
      compiled,
      bookDocument: book,
      sourceUpdatedAt: book.updated_at,
      files,
      originalFiles: originalRecord.files,
      resourceResolution: resolution,
      versionId: input.versionId,
    });
    input.signal?.throwIfAborted();
    const createdAt = new Date(input.createdAtMs).toISOString();
    const manifest = buildDocumentManifest({
      book: compiled,
      bookId: input.bookId,
      createdAt,
      resources,
      versionId: input.versionId,
    });
    const manifestJson = canonicalJson(manifest);
    await files.write("document-manifest.json", manifestJson);
    const inventory = files.snapshot();
    const marker = validateVersionMarker({
      schema_version: 5,
      shared_files: sharedFiles,
      book_id: input.bookId,
      version_id: input.versionId,
      source_updated_at: book.updated_at,
      predecessor_version_id: input.predecessorVersionId,
      created_at: createdAt,
      complete: true,
      compiler: compilerIdentity,
      book_document_sha256: sha256(documentJson),
      manifest_sha256: sha256(manifestJson),
      files: inventory,
    });
    await files.writeVersionMarker(canonicalJson(marker));
    return {
      bookId: input.bookId,
      sourceUpdatedAt: book.updated_at,
      identity: compiled.identity,
      manifestSha256: sha256(manifestJson),
      versionDirectory: "version",
      versionId: input.versionId,
      pageMaterialization,
    };
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    throw error;
  }
}
