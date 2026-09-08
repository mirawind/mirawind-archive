import { createHash } from "node:crypto";
import { posix, resolve } from "node:path";

import { resolveContainedPath } from "@/platform/filesystem/contained-path";
import { atomicWriteFile } from "@/platform/filesystem/atomic-file";

export interface BuildFileDescriptor {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface BuildFileSink {
  record(file: BuildFileDescriptor): void;
  write(path: string, content: string | Uint8Array): Promise<void>;
}

export interface BuildFileInventory extends BuildFileSink {
  snapshot(): readonly BuildFileDescriptor[];
  writeVersionMarker(content: string): Promise<void>;
}

function descriptor(
  path: string,
  content: string | Uint8Array,
): BuildFileDescriptor {
  const bytes =
    typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return Object.freeze({
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  });
}

function validateDescriptor(file: BuildFileDescriptor): void {
  if (
    file.path.length === 0 ||
    file.path === "." ||
    file.path === ".." ||
    file.path === "version.json" ||
    file.path.startsWith("../") ||
    file.path.endsWith("/") ||
    file.path.includes("\\") ||
    file.path.includes("\0") ||
    posix.isAbsolute(file.path) ||
    posix.normalize(file.path) !== file.path
  ) {
    throw new Error("VERSION_FILE_PATH_INVALID");
  }
  if (
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    !/^[a-f0-9]{64}$/u.test(file.sha256)
  ) {
    throw new Error("VERSION_FILE_DESCRIPTOR_INVALID");
  }
}

export function createBuildFileInventory(root: string): BuildFileInventory {
  const buildRoot = resolve(root);
  const files = new Map<string, BuildFileDescriptor>();

  const record = (file: BuildFileDescriptor): void => {
    validateDescriptor(file);
    if (files.has(file.path)) throw new Error("VERSION_FILE_PATH_DUPLICATE");
    if (files.size >= 1_000_000) throw new Error("VERSION_FILE_COUNT_LIMIT");
    files.set(file.path, Object.freeze({ ...file }));
  };

  return Object.freeze({
    record,
    snapshot(): readonly BuildFileDescriptor[] {
      return Object.freeze(
        [...files.values()].sort((left, right) =>
          Buffer.from(left.path).compare(Buffer.from(right.path)),
        ),
      );
    },
    async write(path: string, content: string | Uint8Array): Promise<void> {
      const file = descriptor(path, content);
      validateDescriptor(file);
      if (files.has(path)) throw new Error("VERSION_FILE_PATH_DUPLICATE");
      const target = await resolveContainedPath(buildRoot, path);
      await atomicWriteFile(target, content, { mode: 0o400 });
      record(file);
    },
    async writeVersionMarker(content: string): Promise<void> {
      await atomicWriteFile(resolve(buildRoot, "version.json"), content, {
        mode: 0o400,
      });
    },
  });
}
