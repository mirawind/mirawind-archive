import { required } from "./required";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import type { StorageLayout } from "@/platform/filesystem/storage-layout";
import { atomicWriteFile } from "@/platform/filesystem/atomic-file";
import { DraftRepository } from "@/modules/publishing/adapters/sqlite/drafts";
import { ImportRepository } from "@/modules/publishing/adapters/sqlite/imports";
import { analyzeImport } from "@/modules/publishing/adapters/worker/analyze-import";
import { prepareDraft } from "@/modules/publishing/adapters/worker/prepare-draft";
import { finalizePreparedDraft } from "@/modules/publishing/adapters/worker/finalize-prepared-draft";
export async function prepareIrBook(
  database: Database.Database,
  layout: StorageLayout,
  archive: Uint8Array,
  profile: "verbatim-v1" | "zh-smart-v2" = "zh-smart-v2",
) {
  const book = new DraftRepository(database).createBook({
    title: "Import",
    nowMs: 1,
  });
  const imports = new ImportRepository(database);
  const uploadPath = `tmp/uploads/book-${book.id}.zip`;
  const archivePath = resolve(layout.root, uploadPath);
  await atomicWriteFile(archivePath, archive, { mode: 0o600 });
  const imported = imports.createUploaded({
    bookId: book.id,
    nowMs: 1,
    expiresAtMs: 100000,
    originalName: "book.zip",
    uploadRelativePath: uploadPath,
    uploadSizeBytes: archive.byteLength,
    uploadSha256: createHash("sha256").update(archive).digest("hex"),
  });
  const analysis = await analyzeImport({
    archivePath,
    stagingDirectory: resolve(layout.root, "staging", imported.id),
  });
  const document = required(analysis.artifact.document);
  imports.startAnalysis(imported.id, 2);
  imports.selectDocument({
    importId: imported.id,
    path: document.path,
    nowMs: 3,
  });
  const prepared = await prepareDraft({
    archivePath,
    bookId: book.id,
    sourcePath: document.path,
    stagingDirectory: resolve(layout.root, "staging", `prepare-${imported.id}`),
    typographyProfile: profile,
  });
  const finalized = await finalizePreparedDraft({
    artifact: prepared.artifact,
    preparedRoot: prepared.preparedRoot,
    database,
    importId: imported.id,
    layout,
    nowMs: 4,
  });
  return { book, imported, prepared, finalized };
}
