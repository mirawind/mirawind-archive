import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { createOpaqueId } from "@/domain/ids";
import { DraftRepository } from "@/modules/publishing/adapters/sqlite/drafts";
import { ImportRepository } from "@/modules/publishing/adapters/sqlite/imports";
import { BuildRepository } from "@/modules/publishing/adapters/sqlite/builds";
import { DocumentRepository } from "@/modules/publishing/adapters/sqlite/documents";
import type {
  BookDocument,
  HeadingBlock,
  ParagraphBlock,
} from "@/modules/publishing/core/content/book-document.generated";
import { atomicWriteFile } from "@/platform/filesystem/atomic-file";
import type { StorageLayout } from "@/platform/filesystem/storage-layout";
import { mineruZip, mineruTitle, mineruParagraph } from "./mineru-v2";

export function smallBook(bookId = 1, updatedAt = 1000): BookDocument {
  const heading = createOpaqueId("block");
  return {
    schema_version: 1,
    book_id: bookId,
    updated_at: updatedAt,
    metadata: { title: "Book" },
    publishing: {
      numbering: "source",
      code: { line_numbers: false },
      boundaries: { body_start_block_id: heading },
    },
    resources: [],
    blocks: [
      {
        id: heading,
        type: "heading",
        level: 1,
        content: [{ type: "text", text: "Chapter" }],
        include_in_toc: true,
        starts_page: true,
        exclude_from_numbering: false,
      },
      {
        id: createOpaqueId("block"),
        type: "paragraph",
        content: [{ type: "text", text: "Body" }],
      },
    ],
  };
}

export function headingBlock(title: string, level = 1): HeadingBlock {
  return {
    id: createOpaqueId("block"),
    type: "heading",
    level,
    content: [{ type: "text", text: title }],
    include_in_toc: true,
    starts_page: level === 1,
    exclude_from_numbering: false,
  };
}
export function paragraphBlock(text: string): ParagraphBlock {
  return {
    id: createOpaqueId("block"),
    type: "paragraph",
    content: [{ type: "text", text }],
  };
}

export async function installIrDraft(
  database: Database.Database,
  layout: StorageLayout,
) {
  const record = new DraftRepository(database).createBook({
    nowMs: 1,
    title: "Book",
  });
  const book = smallBook(record.id);
  const archive = mineruZip([[mineruTitle("Book"), mineruParagraph("Body")]]);
  const archiveHash = createHash("sha256").update(archive).digest("hex");
  const imports = new ImportRepository(database);
  const importId = createOpaqueId("import");
  const imported = imports.createUploaded({
    id: importId,
    bookId: book.book_id,
    nowMs: 1,
    expiresAtMs: 100000,
    originalName: "book.zip",
    uploadRelativePath: `tmp/uploads/${importId}/original.zip`,
    uploadSha256: archiveHash,
    uploadSizeBytes: archive.byteLength,
  });
  database
    .prepare("UPDATE imports SET state='draft_ready' WHERE id=?")
    .run(imported.id);
  new DocumentRepository(database).insert(book);
  await atomicWriteFile(
    resolve(layout.bookDirectory, String(book.book_id), "import/analysis.json"),
    JSON.stringify({ origins: [], diagnostics: [] }),
    { mode: 0o600 },
  );
  database
    .prepare("UPDATE books SET draft_import_id=? WHERE id=?")
    .run(imported.id, book.book_id);
  const originalId = createOpaqueId("file");
  const originalPath = `originals/${originalId}`;
  await atomicWriteFile(
    resolve(layout.bookDirectory, String(book.book_id), originalPath),
    archive,
    { mode: 0o400 },
  );
  database
    .prepare(
      "INSERT INTO original_files (id,book_id,import_id,role,storage_rel_path,original_name,media_type,size_bytes,sha256,created_at) VALUES (?,?,?,'mineru_zip',?,'book.zip','application/zip',?,?,1)",
    )
    .run(
      originalId,
      book.book_id,
      imported.id,
      `books/${book.book_id}/${originalPath}`,
      archive.byteLength,
      archiveHash,
    );
  const candidate = new BuildRepository(database).createForDocument({
    bookId: book.book_id,
    importId: imported.id,
    sourceUpdatedAt: book.updated_at,
    nowMs: 2,
  });
  return { book, imported, build: candidate };
}
