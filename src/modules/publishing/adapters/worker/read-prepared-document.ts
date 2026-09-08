import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { JSONParser } from "@streamparser/json";
import { contentLimits } from "../../core/content/book-document";
import type {
  BookDocument,
  ContentBlock,
} from "../../core/content/book-document.generated";
import {
  documentRootRow,
  type DocumentRootRow,
  type DocumentRows,
} from "../sqlite/documents";

// The preparation child validates the IR. Verify its exact bytes while extracting SQL rows,
// retaining only one parsed root at a time in the worker supervisor.
export async function readPreparedDocument(
  path: string,
  expected: { bookId: number; updatedAt: number; sha256: string },
): Promise<DocumentRows> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > contentLimits.bytes
  )
    throw new Error("IMPORT_DOCUMENT_INVALID");
  const fields = [
    "schema_version",
    "book_id",
    "updated_at",
    "alias",
    "metadata",
    "publishing",
    "resources",
  ];
  const header: Record<string, unknown> = {};
  const roots: DocumentRootRow[] = [];
  const parser = new JSONParser({
    paths: [...fields.map((key) => "$." + key), "$.blocks.*"],
    keepStack: false,
    stringBufferSize: 65536,
  });
  parser.onValue = ({ key, value }) => {
    if (typeof key === "number") {
      if (key !== roots.length || roots.length >= contentLimits.topLevelBlocks)
        throw new Error("IMPORT_DOCUMENT_INVALID");
      roots.push(documentRootRow(value as unknown as ContentBlock));
    } else if (typeof key === "string" && fields.includes(key))
      header[key] = value;
  };
  const hash = createHash("sha256"),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  for await (const chunk of handle.createReadStream({
    highWaterMark: 65536,
  })) {
    bytes += chunk.byteLength;
    if (bytes > contentLimits.bytes) throw new Error("IMPORT_DOCUMENT_INVALID");
    hash.update(chunk);
    decoder.decode(chunk, { stream: true });
    parser.write(chunk);
  }
  decoder.decode();
  if (!parser.isEnded) parser.end();
  if (hash.digest("hex") !== expected.sha256)
    throw new Error("IMPORT_DOCUMENT_INTEGRITY_MISMATCH");
  if (
    header.schema_version !== 1 ||
    header.book_id !== expected.bookId ||
    header.updated_at !== expected.updatedAt ||
    roots.length === 0
  )
    throw new Error("IMPORT_DOCUMENT_IDENTITY_MISMATCH");
  return { header: header as Omit<BookDocument, "blocks">, roots };
}
