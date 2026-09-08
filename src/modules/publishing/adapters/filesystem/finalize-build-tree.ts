import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { validateVersionMarker } from "../../core/publication/document-manifest-schema";
import type { BuildTreeCrashPointInjector } from "../../application/build-durability";
import { injectBuildTreeCrashPoint } from "../../application/build-durability";
import { resolveContainedPath } from "@/platform/filesystem/contained-path";

export interface BuildTreeLayout {
  readonly bookDirectory: string;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncTree(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error("VERSION_LINK_REJECTED");
    if (entry.isDirectory()) await syncTree(child);
    else if (entry.isFile()) {
      const handle = await open(child, "r");
      try {
        await handle.sync();
        await handle.chmod(0o400);
      } finally {
        await handle.close();
      }
    } else {
      throw new Error("VERSION_SPECIAL_FILE_REJECTED");
    }
  }
  await syncDirectory(path);
  await chmod(path, 0o500);
}

async function digestFile(
  path: string,
): Promise<{ readonly sha256: string; readonly size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer;
    size += bytes.byteLength;
    hash.update(bytes);
  }
  return Object.freeze({ sha256: hash.digest("hex"), size });
}

async function validateFileClosure(
  root: string,
  marker: Readonly<Record<string, unknown>>,
): Promise<void> {
  const actual = new Map<
    string,
    { readonly sha256: string; readonly size: number }
  >();
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const child = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("VERSION_LINK_REJECTED");
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        const path = relative(root, child).split(sep).join("/");
        if (path !== "version.json") actual.set(path, await digestFile(child));
      } else {
        throw new Error("VERSION_SPECIAL_FILE_REJECTED");
      }
      if (actual.size > 1_000_000) throw new Error("VERSION_FILE_COUNT_LIMIT");
    }
  };
  await visit(root);
  const declared = marker.files as readonly Readonly<Record<string, unknown>>[];
  if (actual.size !== declared.length) {
    throw new Error("VERSION_FILE_CLOSURE_MISMATCH");
  }
  for (const file of declared) {
    const found = actual.get(String(file.path));
    if (!found || found.size !== file.size || found.sha256 !== file.sha256) {
      throw new Error("VERSION_FILE_INTEGRITY_MISMATCH");
    }
  }
}

export async function finalizeBuildTree(input: {
  readonly artifact: {
    readonly bookId: number;
    readonly versionDirectory: "version";
    readonly versionId: string;
  };
  readonly crashPoint?: BuildTreeCrashPointInjector;
  readonly layout: BuildTreeLayout;
  readonly stagingDirectory: string;
}): Promise<string> {
  const stagedVersion = await resolveContainedPath(
    input.stagingDirectory,
    input.artifact.versionDirectory,
  );
  if (
    (await stat(resolve(stagedVersion, "version.json"))).size >
    16 * 1024 * 1024
  ) {
    throw new Error("VERSION_MARKER_TOO_LARGE");
  }
  const marker = validateVersionMarker(
    JSON.parse(await readFile(resolve(stagedVersion, "version.json"), "utf8")),
  );
  if (
    marker.book_id !== input.artifact.bookId ||
    marker.version_id !== input.artifact.versionId
  ) {
    throw new Error("VERSION_MARKER_CAPTURE_MISMATCH");
  }
  await validateFileClosure(stagedVersion, marker);
  const finalDirectory = resolve(
    input.layout.bookDirectory,
    String(input.artifact.bookId),
    "builds",
    input.artifact.versionId,
  );
  await mkdir(dirname(finalDirectory), { mode: 0o700, recursive: true });
  if (
    await lstat(finalDirectory)
      .then(() => true)
      .catch(() => false)
  ) {
    throw new Error("VERSION_DIRECTORY_EXISTS");
  }
  await injectBuildTreeCrashPoint(input.crashPoint, "before_fsync");
  await syncTree(stagedVersion);
  await injectBuildTreeCrashPoint(
    input.crashPoint,
    "after_fsync_before_rename",
  );
  await chmod(stagedVersion, 0o700);
  try {
    await rename(stagedVersion, finalDirectory);
    await chmod(finalDirectory, 0o500);
    await syncDirectory(dirname(finalDirectory));
    await injectBuildTreeCrashPoint(input.crashPoint, "after_rename");
    return finalDirectory;
  } catch (error) {
    await chmod(stagedVersion, 0o700).catch(() => undefined);
    throw error;
  }
}
