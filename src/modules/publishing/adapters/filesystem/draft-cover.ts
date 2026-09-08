import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { SafeApplicationError } from "@/domain/errors";
import { createOpaqueId } from "@/domain/ids";
import { maximumCoverUploadBytes } from "../../application/cover-upload-policy";
import type { StorageLayout } from "@/platform/filesystem/storage-layout";
import { atomicWriteFile } from "@/platform/filesystem/atomic-file";
import { withImmediateTransaction } from "@/platform/sqlite/immediate-transaction";
import { DocumentRepository } from "../sqlite/documents";
import { saveDocument } from "../sqlite/save-document";
import { inspectRasterImage } from "../../core/publication/inspect-image";

export async function uploadDraftCover(input: {
  bookId: number;
  bytes: Uint8Array;
  database: Database.Database;
  expectedUpdatedAt: number;
  filename: string;
  layout: StorageLayout;
  nowMs: number;
}) {
  if (
    !input.bytes.byteLength ||
    input.bytes.byteLength > maximumCoverUploadBytes
  )
    throw new SafeApplicationError(
      "COVER_SIZE_LIMIT",
      "The cover exceeds the size limit.",
      413,
    );
  const documents = new DocumentRepository(input.database);
  documents.requireTimestamp(input.bookId, input.expectedUpdatedAt);
  const image = await inspectRasterImage({
    bytes: input.bytes,
    filename: input.filename,
  });
  const id = createOpaqueId("resource"),
    path = "books/" + input.bookId + "/assets/" + id + "." + image.format;
  await atomicWriteFile(resolve(input.layout.root, path), input.bytes, {
    mode: 0o400,
  });
  try {
    return withImmediateTransaction(input.database, () => {
      documents.requireTimestamp(input.bookId, input.expectedUpdatedAt);
      input.database
        .prepare(
          "INSERT INTO book_resources(id,book_id,storage_rel_path,media_type,size_bytes,sha256,created_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          id,
          input.bookId,
          path,
          "image/" + image.format,
          input.bytes.byteLength,
          createHash("sha256").update(input.bytes).digest("hex"),
          input.nowMs,
        );
      return {
        ...saveDocument({
          ...input,
          patch: { metadata: { cover_resource_id: id } },
          requestId: createOpaqueId("job"),
        }),
        resource_id: id,
      };
    });
  } catch (error) {
    await rm(resolve(input.layout.root, path), { force: true });
    throw error;
  }
}
