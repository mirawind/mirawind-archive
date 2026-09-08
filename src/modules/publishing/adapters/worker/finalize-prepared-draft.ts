import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import { BuildRepository } from "../sqlite/builds";
import { DocumentRepository, type DocumentRows } from "../sqlite/documents";
import { ImportRepository } from "../sqlite/imports";
import {
  readPreparedDraftArtifact,
  type PreparedDraftArtifact,
} from "./prepared-draft-artifact";
import { readPreparedDocument } from "./read-prepared-document";
import type { StorageLayout } from "@/platform/filesystem/storage-layout";
import { atomicWriteFile } from "@/platform/filesystem/atomic-file";
import { withImmediateTransaction } from "@/platform/sqlite/immediate-transaction";

export async function finalizePreparedDraft(input: {
  artifact: PreparedDraftArtifact;
  database: Database.Database;
  preparedRoot: string;
  importId: string;
  layout: StorageLayout;
  nowMs: number;
}) {
  const imports = new ImportRepository(input.database),
    imported = imports.require(input.importId);
  if (
    imported.bookId !== input.artifact.bookId ||
    !["preparing", "draft_ready"].includes(imported.state)
  )
    throw new Error("IMPORT_PREPARE_STATE_CONFLICT");
  const finalRoot = resolve(
    input.layout.bookDirectory,
    String(input.artifact.bookId),
  );
  const recordPath = resolve(finalRoot, "import/record.json");
  const existing = await readFile(recordPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  let artifact = input.artifact;
  let document: DocumentRows | undefined;
  if (existing !== null) {
    const record = JSON.parse(existing) as { import_id: string };
    if (record.import_id !== imported.id)
      throw new Error("IMPORT_BOOK_STORAGE_EXISTS");
    artifact = await readPreparedDraftArtifact(recordPath);
  } else {
    if (
      artifact.original.sha256 !== imported.uploadSha256 ||
      artifact.original.size !== imported.uploadSizeBytes
    )
      throw new Error("IMPORT_ORIGINAL_INTEGRITY_MISMATCH");
    document = await readPreparedDocument(
      resolve(input.preparedRoot, "import/book.json"),
      {
        bookId: artifact.bookId,
        updatedAt: artifact.sourceUpdatedAt,
        sha256: artifact.documentSha256,
      },
    );
    await atomicWriteFile(
      resolve(input.preparedRoot, "import/record.json"),
      JSON.stringify({ ...artifact, import_id: imported.id }),
      { mode: 0o600 },
    );
    await mkdir(dirname(finalRoot), { recursive: true, mode: 0o700 });
    await rename(input.preparedRoot, finalRoot);
    const parent = await open(dirname(finalRoot), "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
  const documents = new DocumentRepository(input.database),
    builds = new BuildRepository(input.database);
  if (imported.state !== "draft_ready" && !document)
    document = await readPreparedDocument(
      resolve(finalRoot, "import/book.json"),
      {
        bookId: artifact.bookId,
        updatedAt: artifact.sourceUpdatedAt,
        sha256: artifact.documentSha256,
      },
    );
  const originalRelative =
    "books/" + artifact.bookId + "/originals/" + artifact.original.id;
  const build = withImmediateTransaction(input.database, () => {
    const current = imports.require(imported.id);
    if (current.state === "draft_ready") {
      const existing = builds.findCurrent(artifact.bookId);
      if (!existing) throw new Error("IMPORT_BUILD_MISSING");
      return existing;
    }
    if (!document) throw new Error("IMPORT_DOCUMENT_MISSING");
    const insert = input.database.prepare(
      "INSERT INTO book_resources(id,book_id,storage_rel_path,media_type,size_bytes,sha256,created_at) VALUES (?,?,?,?,?,?,?)",
    );
    for (const resource of artifact.resources)
      insert.run(
        resource.id,
        artifact.bookId,
        relative(input.layout.root, resolve(finalRoot, resource.path))
          .split(sep)
          .join("/"),
        resource.media_type,
        resource.size,
        resource.sha256,
        input.nowMs,
      );
    input.database
      .prepare(
        "INSERT INTO original_files(id,book_id,import_id,role,storage_rel_path,original_name,media_type,size_bytes,sha256,created_at) VALUES (?,?,?,'mineru_zip',?,?,'application/zip',?,?,?)",
      )
      .run(
        artifact.original.id,
        artifact.bookId,
        imported.id,
        originalRelative,
        imported.originalName,
        artifact.original.size,
        artifact.original.sha256,
        input.nowMs,
      );
    documents.insertPrepared(document);
    input.database
      .prepare("UPDATE books SET title_cache=?,draft_import_id=? WHERE id=?")
      .run(artifact.title, imported.id, artifact.bookId);
    imports.attachPreparedBook({
      bookId: artifact.bookId,
      importId: imported.id,
      nowMs: input.nowMs,
    });
    input.database
      .prepare("UPDATE imports SET upload_rel_path=? WHERE id=?")
      .run(originalRelative, imported.id);
    return builds.createForDocument({
      bookId: artifact.bookId,
      importId: imported.id,
      sourceUpdatedAt: artifact.sourceUpdatedAt,
      nowMs: input.nowMs,
    });
  });
  await rm(resolve(finalRoot, "import/book.json"), { force: true });
  if (
    imported.uploadRelativePath !== originalRelative &&
    imported.uploadRelativePath ===
      "tmp/uploads/" + imported.id + "/original.zip"
  )
    await rm(resolve(input.layout.root, "tmp/uploads", imported.id), {
      force: true,
      recursive: true,
    });
  return {
    bookId: artifact.bookId,
    sourceUpdatedAt: artifact.sourceUpdatedAt,
    build,
  };
}
