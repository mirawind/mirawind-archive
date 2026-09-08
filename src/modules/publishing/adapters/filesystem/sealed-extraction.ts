import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { isOpaqueId } from "@/domain/ids";
import type { ArchiveExtractionResult } from "./extract-archive";
import { atomicWriteFile } from "@/platform/filesystem/atomic-file";

const markerFilename = "marker.json";
const markerMaximumBytes = 4 * 1024;
const sealedExtractionSchemaVersion = 1 as const;
const treeDirectoryName = "tree";

export interface SealedExtractionStats {
  readonly entries: number;
  readonly files: number;
  readonly totalUncompressedBytes: number;
}

interface SealedExtractionMarker extends SealedExtractionStats {
  readonly import_id: string;
  readonly schema_version: typeof sealedExtractionSchemaVersion;
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function metadata(path: string): Promise<Stats | null> {
  return lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function markerFor(input: {
  readonly importId: string;
  readonly extraction: ArchiveExtractionResult;
}): SealedExtractionMarker {
  if (!isOpaqueId("import", input.importId)) {
    throw new Error("SEALED_EXTRACTION_IMPORT_INVALID");
  }
  return Object.freeze({
    entries: input.extraction.entries,
    files: input.extraction.files,
    import_id: input.importId,
    schema_version: sealedExtractionSchemaVersion,
    totalUncompressedBytes: input.extraction.totalUncompressedBytes,
  });
}

function parseMarker(
  value: unknown,
  expectedImportId: string,
): SealedExtractionMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SEALED_EXTRACTION_MARKER_INVALID");
  }
  const marker = value as Record<string, unknown>;
  const expectedKeys = [
    "entries",
    "files",
    "import_id",
    "schema_version",
    "totalUncompressedBytes",
  ];
  const keys = Object.keys(marker).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    marker.schema_version !== sealedExtractionSchemaVersion ||
    marker.import_id !== expectedImportId ||
    !isOpaqueId("import", expectedImportId) ||
    !Number.isSafeInteger(marker.entries) ||
    Number(marker.entries) < 1 ||
    !Number.isSafeInteger(marker.files) ||
    Number(marker.files) < 1 ||
    Number(marker.files) > Number(marker.entries) ||
    !Number.isSafeInteger(marker.totalUncompressedBytes) ||
    Number(marker.totalUncompressedBytes) < 1
  ) {
    throw new Error("SEALED_EXTRACTION_MARKER_INVALID");
  }
  return marker as unknown as SealedExtractionMarker;
}

async function readMarker(
  sealedDirectory: string,
  expectedImportId: string,
): Promise<SealedExtractionMarker> {
  const markerPath = resolve(sealedDirectory, markerFilename);
  const handle = await open(
    markerPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const markerMetadata = await handle.stat();
    if (!markerMetadata.isFile() || markerMetadata.size > markerMaximumBytes) {
      throw new Error("SEALED_EXTRACTION_MARKER_INVALID");
    }
    const contents = await handle.readFile("utf8");
    return parseMarker(JSON.parse(contents) as unknown, expectedImportId);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("SEALED_EXTRACTION_MARKER_INVALID", { cause: error });
    }
    throw error;
  } finally {
    await handle.close();
  }
}

export async function sealExtractedDirectory(input: {
  readonly extractedRoot: string;
  readonly extraction: ArchiveExtractionResult;
  readonly importId: string;
  readonly sealedDirectory: string;
}): Promise<void> {
  const extractedRoot = resolve(input.extractedRoot);
  const sealedDirectory = resolve(input.sealedDirectory);
  const assemblyDirectory = resolve(
    dirname(extractedRoot),
    ".sealed-extraction-assembly",
  );
  const tree = resolve(assemblyDirectory, treeDirectoryName);
  const marker = markerFor(input);
  await mkdir(dirname(sealedDirectory), { mode: 0o700, recursive: true });
  await mkdir(assemblyDirectory, { mode: 0o700, recursive: false });
  try {
    await rename(extractedRoot, tree);
    await atomicWriteFile(
      resolve(assemblyDirectory, markerFilename),
      `${JSON.stringify(marker)}\n`,
      { mode: 0o600 },
    );
    await syncDirectory(assemblyDirectory);
    if (await metadata(sealedDirectory)) {
      await rm(sealedDirectory, { force: true, recursive: true });
    }
    await rename(assemblyDirectory, sealedDirectory);
    await syncDirectory(dirname(sealedDirectory));
  } catch (error) {
    await rm(assemblyDirectory, { force: true, recursive: true });
    throw error;
  }
}

export async function claimSealedExtraction(input: {
  readonly expectedImportId: string;
  readonly sealedDirectory: string;
  readonly stagingDirectory: string;
}): Promise<SealedExtractionStats | null> {
  const sealedDirectory = resolve(input.sealedDirectory);
  const stagingDirectory = resolve(input.stagingDirectory);
  const claimDirectory = resolve(stagingDirectory, ".sealed-extraction-claim");
  try {
    await rename(sealedDirectory, claimDirectory);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }

  let treeClaimed = false;
  try {
    const claimMetadata = await metadata(claimDirectory);
    const tree = resolve(claimDirectory, treeDirectoryName);
    const treeMetadata = await metadata(tree);
    if (
      !claimMetadata?.isDirectory() ||
      claimMetadata.isSymbolicLink() ||
      !treeMetadata?.isDirectory() ||
      treeMetadata.isSymbolicLink()
    ) {
      throw new Error("SEALED_EXTRACTION_TREE_INVALID");
    }
    const marker = await readMarker(claimDirectory, input.expectedImportId);
    await rename(tree, resolve(stagingDirectory, "extracted"));
    treeClaimed = true;
    await rm(claimDirectory, { force: true, recursive: true });
    await syncDirectory(stagingDirectory);
    return Object.freeze({
      entries: marker.entries,
      files: marker.files,
      totalUncompressedBytes: marker.totalUncompressedBytes,
    });
  } catch (error) {
    await rm(claimDirectory, { force: true, recursive: true });
    if (treeClaimed) throw error;
    return null;
  }
}
