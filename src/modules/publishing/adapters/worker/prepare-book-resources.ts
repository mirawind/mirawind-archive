import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BookDocument } from "../../core/content/book-document.generated";
import { inspectRasterImage } from "../../core/publication/inspect-image";
import type { PreparedResource } from "./prepared-draft-artifact";
import { atomicWriteFile } from "@/platform/filesystem/atomic-file";
import { resolveContainedPath } from "@/platform/filesystem/contained-path";

export async function prepareBookResources(
  book: BookDocument,
  sourceRoot: string,
  destinationRoot: string,
  signal?: AbortSignal,
): Promise<PreparedResource[]> {
  const resources: PreparedResource[] = [];
  for (const resource of book.resources) {
    signal?.throwIfAborted();
    const path = await resolveContainedPath(sourceRoot, resource.path);
    const bytes = await readFile(path);
    const image = await inspectRasterImage({ bytes, filename: resource.path });
    const extension = image.format === "jpeg" ? "jpg" : image.format;
    resource.path = `assets/${resource.id}.${extension}`;
    resource.media_type = `image/${image.format}`;
    await atomicWriteFile(resolve(destinationRoot, resource.path), bytes, {
      mode: 0o400,
    });
    resources.push({
      ...resource,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width: image.width,
      height: image.height,
    });
  }
  return resources;
}
