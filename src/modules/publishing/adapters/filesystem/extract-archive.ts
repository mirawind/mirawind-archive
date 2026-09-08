import { mkdir, rm, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ZipReader } from "@zip.js/zip.js";
import { SafeApplicationError } from "@/domain/errors";
import { resolveContainedPath } from "@/platform/filesystem/contained-path";
import { openExclusiveFile } from "@/platform/filesystem/atomic-file";
import { NodeFileReader } from "./zip-file-reader";

export interface ArchiveExtractionResult {
  readonly entries: number;
  readonly files: number;
  readonly totalCompressedBytes: number;
  readonly totalUncompressedBytes: number;
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (result.bytesWritten <= 0)
      throw new Error("Archive extraction write made no progress");
    offset += result.bytesWritten;
  }
}

export async function extractZipFile(input: {
  readonly archivePath: string;
  readonly destination: string;
  readonly signal?: AbortSignal;
}): Promise<ArchiveExtractionResult> {
  const destination = resolve(input.destination);
  const source = new NodeFileReader(input.archivePath);
  const reader = new ZipReader(source, { useWebWorkers: false });
  let destinationCreated = false;
  let totalCompressedBytes = 0;
  let totalUncompressedBytes = 0;
  let files = 0;
  let entries = 0;
  try {
    input.signal?.throwIfAborted();
    await mkdir(destination, { mode: 0o700, recursive: false });
    destinationCreated = true;
    for await (const entry of reader.getEntriesGenerator()) {
      input.signal?.throwIfAborted();
      entries += 1;
      const path = entry.filename
        .replaceAll("\\", "/")
        .split("/")
        .filter((component) => component && component !== ".")
        .join("/")
        .normalize("NFC");
      if (!path && entry.directory) continue;
      const target = await resolveContainedPath(destination, path);
      if (entry.directory) {
        await mkdir(target, { mode: 0o700, recursive: true });
        continue;
      }
      totalCompressedBytes += entry.compressedSize;
      await mkdir(dirname(target), { mode: 0o700, recursive: true });
      const handle = await openExclusiveFile(target);
      try {
        await entry.getData(
          new WritableStream<Uint8Array>({
            async write(chunk) {
              input.signal?.throwIfAborted();
              await writeAll(handle, chunk);
              totalUncompressedBytes += chunk.byteLength;
            },
          }),
          {
            ...(input.signal ? { signal: input.signal } : {}),
          },
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      files += 1;
    }
    return Object.freeze({
      entries,
      files,
      totalCompressedBytes,
      totalUncompressedBytes,
    });
  } catch (error) {
    if (destinationCreated)
      await rm(destination, { force: true, recursive: true });
    if (input.signal?.aborted) {
      throw new SafeApplicationError(
        "ARCHIVE_CANCELED",
        "Archive extraction was canceled.",
        400,
        { cause: error },
      );
    }
    if (error instanceof SafeApplicationError) throw error;
    throw new SafeApplicationError(
      "ARCHIVE_MALFORMED",
      "The ZIP archive could not be extracted.",
      400,
      { cause: error },
    );
  } finally {
    try {
      await reader.close();
    } finally {
      await source.dispose();
    }
  }
}
