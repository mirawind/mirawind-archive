import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { SafeApplicationError } from "@/domain/errors";
import { withImmediateTransaction } from "@/platform/sqlite/immediate-transaction";
import {
  nextContentTimestamp,
  validateBookDocument,
} from "../../core/content/book-document";
import type {
  BookDocument,
  ContentBlock,
  ListItem,
} from "../../core/content/book-document.generated";
import { contentEntries } from "../../core/content/content-tree";
import { contentResourceIds } from "../../core/content/resource-references";
import { ResourceRepository } from "./resources";
import { parseDraftEdit } from "../../core/content/edit-book";
import { prepareDraftEdit } from "../../core/content/prepare-edit";
import { documentEditContext } from "./document-edit-context";
import {
  blockEditorText,
  inlineEditorText,
} from "../../core/content/editor-text";

interface DocumentRow {
  book_id: number;
  schema_version: 1;
  updated_at: number;
  alias: string | null;
  metadata_json: string;
  publishing_json: string;
}
export interface DocumentRootRow {
  readonly id: string;
  readonly type: ContentBlock["type"];
  readonly json: string;
  readonly nodes: readonly { readonly id: string; readonly kind: string }[];
  readonly resourceIds: readonly string[];
}
export interface DocumentRows {
  readonly header: Omit<BookDocument, "blocks">;
  readonly roots: readonly DocumentRootRow[];
}
export function documentRootRow(block: ContentBlock): DocumentRootRow {
  return {
    id: block.id,
    type: block.type,
    json: JSON.stringify(block),
    resourceIds: contentResourceIds([block]),
    nodes: [...contentEntries([block])].map(({ node, kind }) => ({
      id: node.id,
      kind,
    })),
  };
}
function missing(): never {
  throw new SafeApplicationError("NOT_FOUND", "The draft was not found.", 404);
}
function conflict(): never {
  throw new SafeApplicationError(
    "DRAFT_PRECONDITION_FAILED",
    "The draft changed since it was read.",
    412,
  );
}

export class DocumentRepository {
  private readonly resources: ResourceRepository;
  constructor(private readonly database: Database.Database) {
    this.resources = new ResourceRepository(database);
  }

  header(bookId: number): Omit<BookDocument, "blocks"> {
    const row = this.database
      .prepare(
        "SELECT document.* FROM book_documents document JOIN books ON books.id=document.book_id WHERE document.book_id=? AND books.deletion_requested_at IS NULL",
      )
      .get(bookId) as DocumentRow | undefined;
    if (!row) missing();
    const resources = this.database
      .prepare(
        "SELECT id,storage_rel_path,media_type FROM book_resources WHERE book_id=? AND deletion_requested_at IS NULL ORDER BY rowid",
      )
      .all(bookId) as {
      id: string;
      storage_rel_path: string;
      media_type: string;
    }[];
    return {
      schema_version: row.schema_version,
      book_id: row.book_id,
      updated_at: row.updated_at,
      ...(row.alias ? { alias: row.alias } : {}),
      metadata: JSON.parse(row.metadata_json),
      publishing: JSON.parse(row.publishing_json),
      resources: resources.map((resource) => ({
        id: resource.id,
        path: resource.storage_rel_path.slice(`books/${bookId}/`.length),
        media_type: resource.media_type,
      })),
    };
  }

  timestamp(bookId: number): number {
    const row = this.database
      .prepare(
        "SELECT document.updated_at FROM book_documents document JOIN books ON books.id=document.book_id WHERE document.book_id=? AND books.deletion_requested_at IS NULL",
      )
      .get(bookId) as { updated_at: number } | undefined;
    if (!row) missing();
    return row.updated_at;
  }

  requireTimestamp(bookId: number, expected: number): void {
    if (this.timestamp(bookId) !== expected) conflict();
  }

  read(bookId: number): BookDocument {
    return this.database
      .transaction(() => {
        const header = this.header(bookId);
        const rows = this.database
          .prepare(
            "SELECT content_json FROM book_blocks WHERE book_id=? ORDER BY ordinal",
          )
          .all(bookId) as { content_json: string }[];
        return {
          ...header,
          blocks: rows.map(
            (row) => JSON.parse(row.content_json) as ContentBlock,
          ),
        };
      })
      .deferred();
  }

  view(bookId: number) {
    return this.database
      .transaction(() => {
        const header = this.header(bookId);
        const rows = this.database
          .prepare(
            "SELECT content_json FROM book_blocks block WHERE book_id=? AND EXISTS (SELECT 1 FROM book_nodes node WHERE node.book_id=block.book_id AND node.root_id=block.id AND node.kind='heading') ORDER BY ordinal",
          )
          .all(bookId) as { content_json: string }[];
        return {
          ...header,
          alias: header.alias ?? null,
          structure: rows.flatMap((row) =>
            [
              ...contentEntries([JSON.parse(row.content_json) as ContentBlock]),
            ].flatMap(({ node }) => {
              if (!("type" in node) || node.type !== "heading") return [];
              return [
                {
                  block_id: node.id,
                  display_level: node.level,
                  title_markdown: inlineEditorText(node.content, header),
                  include_in_toc: node.include_in_toc,
                  starts_page: node.starts_page,
                  exclude_from_numbering: node.exclude_from_numbering,
                  ...(node.source_number
                    ? { source_number: node.source_number }
                    : {}),
                  ...(node.alias ? { alias: node.alias } : {}),
                },
              ];
            }),
          ),
        };
      })
      .deferred();
  }

  captureBuild(bookId: number, updatedAt: number, importId: string) {
    return this.database
      .transaction(() => {
        const book = this.header(bookId);
        if (book.updated_at !== updatedAt) throw new Error("BUILD_SUPERSEDED");
        const blocks = this.database
          .prepare(
            "SELECT content_json FROM book_blocks WHERE book_id=? ORDER BY ordinal",
          )
          .pluck()
          .all(bookId) as string[];
        const resources = this.database
          .prepare(
            `SELECT id,storage_rel_path AS path,size_bytes AS size,sha256,media_type FROM book_resources
             WHERE book_id=@bookId AND deletion_requested_at IS NULL AND
             (id=@coverId OR id IN (SELECT resource_id FROM book_block_resources WHERE book_id=@bookId)) ORDER BY rowid`,
          )
          .all({
            bookId,
            coverId: book.metadata.cover_resource_id ?? null,
          }) as {
          id: string;
          path: string;
          size: number;
          sha256: string;
          media_type: string;
        }[];
        const used = new Set(resources.map((resource) => resource.id));
        book.resources = book.resources.filter((resource) =>
          used.has(resource.id),
        );
        const originals = this.database
          .prepare(
            "SELECT id,storage_rel_path AS path,size_bytes AS size,sha256,media_type,original_name AS filename FROM original_files WHERE book_id=? AND import_id=?",
          )
          .all(bookId, importId);
        return { book, blocks, resources, originals };
      })
      .deferred();
  }

  block(bookId: number, blockId: string) {
    return this.database
      .transaction(() => {
        const header = this.header(bookId);
        const row = this.database
          .prepare(
            "SELECT block.content_json FROM book_nodes node JOIN book_blocks block ON block.book_id=node.book_id AND block.id=node.root_id WHERE node.book_id=? AND node.id=?",
          )
          .get(bookId, blockId) as { content_json: string } | undefined;
        if (!row) missing();
        const root = JSON.parse(row.content_json) as ContentBlock;
        const entry = [...contentEntries([root])].find(
          (entry) => entry.node.id === blockId,
        );
        if (!entry) missing();
        return {
          block_id: blockId,
          updated_at: header.updated_at,
          kind: entry.kind,
          markdown: blockEditorText(
            entry.node as ContentBlock | ListItem,
            header,
          ),
        };
      })
      .deferred();
  }

  private writeRoot(
    bookId: number,
    root: DocumentRootRow,
    ordinal: number,
  ): void {
    this.database
      .prepare(
        "UPDATE book_blocks SET type=?,content_json=? WHERE book_id=? AND id=? AND ordinal=?",
      )
      .run(root.type, root.json, bookId, root.id, ordinal);
    this.database
      .prepare("DELETE FROM book_nodes WHERE book_id=? AND root_id=?")
      .run(bookId, root.id);
    const insert = this.database.prepare(
      "INSERT INTO book_nodes(book_id,id,root_id,kind) VALUES (?,?,?,?)",
    );
    for (const node of root.nodes)
      insert.run(bookId, node.id, root.id, node.kind);
    this.resources.replaceRoot(bookId, root.id, root.resourceIds);
  }

  insert(input: BookDocument): void {
    const book = validateBookDocument(input);
    const { blocks, ...header } = book;
    this.insertPrepared({ header, roots: blocks.map(documentRootRow) });
  }

  insertPrepared(input: DocumentRows): void {
    const book = input.header;
    withImmediateTransaction(this.database, () => {
      this.database
        .prepare(
          "INSERT INTO book_documents(book_id,schema_version,updated_at,alias,metadata_json,publishing_json) VALUES (?,?,?,?,?,?)",
        )
        .run(
          book.book_id,
          book.schema_version,
          book.updated_at,
          book.alias ?? null,
          JSON.stringify(book.metadata),
          JSON.stringify(book.publishing),
        );
      const blockInsert = this.database.prepare(
        "INSERT INTO book_blocks(book_id,id,ordinal,type,content_json) VALUES (?,?,?,?,?)",
      );
      const nodeInsert = this.database.prepare(
        "INSERT INTO book_nodes(book_id,id,root_id,kind) VALUES (?,?,?,?)",
      );
      for (const [ordinal, root] of input.roots.entries()) {
        blockInsert.run(book.book_id, root.id, ordinal, root.type, root.json);
        for (const node of root.nodes)
          nodeInsert.run(book.book_id, node.id, root.id, node.kind);
        if (root.resourceIds.length)
          this.resources.replaceRoot(book.book_id, root.id, root.resourceIds);
      }
    });
  }

  edit(input: {
    bookId: number;
    patch: unknown;
    expectedUpdatedAt: number;
    nowMs: number;
    requestId: string;
    onChanged: (book: Pick<BookDocument, "book_id" | "updated_at">) => void;
  }) {
    const patch = parseDraftEdit(input.patch);
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(input.requestId))
      throw new SafeApplicationError(
        "DRAFT_REQUEST_INVALID",
        "A save request identity is required.",
        400,
      );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ expected: input.expectedUpdatedAt, patch }))
      .digest("hex");
    const receipt = () => {
      const row = this.database
        .prepare(
          "SELECT request_sha256,updated_at FROM document_commands WHERE book_id=? AND request_id=?",
        )
        .get(input.bookId, input.requestId) as
        { request_sha256: string; updated_at: number } | undefined;
      if (row && row.request_sha256 !== fingerprint)
        throw new SafeApplicationError(
          "DRAFT_REQUEST_CONFLICT",
          "The save request identity was reused.",
          409,
        );
      return row;
    };
    const accepted = receipt();
    if (accepted) return { updated_at: accepted.updated_at };
    const prepared = this.database
      .transaction(() => {
        const header = this.header(input.bookId);
        if (header.updated_at !== input.expectedUpdatedAt) conflict();
        return prepareDraftEdit(
          documentEditContext(this.database, header),
          patch,
        );
      })
      .deferred();
    const next = {
      ...prepared.header,
      updated_at: prepared.changed
        ? nextContentTimestamp(input.expectedUpdatedAt, input.nowMs)
        : input.expectedUpdatedAt,
    };
    const roots = prepared.roots.map((root) => ({
      ordinal: root.ordinal,
      row: documentRootRow(root.block),
    }));
    return withImmediateTransaction(this.database, () => {
      const prior = receipt();
      if (prior) return { updated_at: prior.updated_at };
      this.requireTimestamp(input.bookId, input.expectedUpdatedAt);
      if (prepared.changed) {
        const coverIds = next.metadata.cover_resource_id
          ? [next.metadata.cover_resource_id]
          : [];
        this.resources.requireAvailable(input.bookId, coverIds);
        this.resources.touch(input.bookId, coverIds);
        for (const root of roots)
          this.writeRoot(input.bookId, root.row, root.ordinal);
        this.database
          .prepare(
            "UPDATE book_documents SET updated_at=?,alias=?,metadata_json=?,publishing_json=? WHERE book_id=?",
          )
          .run(
            next.updated_at,
            next.alias ?? null,
            JSON.stringify(next.metadata),
            JSON.stringify(next.publishing),
            input.bookId,
          );
        if (patch.metadata?.title !== undefined)
          this.database
            .prepare("UPDATE books SET title_cache=? WHERE id=?")
            .run(next.metadata.title, input.bookId);
        input.onChanged(next);
      }
      this.database
        .prepare(
          "INSERT INTO document_commands(book_id,request_id,request_sha256,updated_at,created_at) VALUES (?,?,?,?,?)",
        )
        .run(
          input.bookId,
          input.requestId,
          fingerprint,
          next.updated_at,
          input.nowMs,
        );
      this.database
        .prepare(
          "DELETE FROM document_commands WHERE book_id=? AND rowid NOT IN (SELECT rowid FROM document_commands WHERE book_id=? ORDER BY rowid DESC LIMIT 64)",
        )
        .run(input.bookId, input.bookId);
      return { updated_at: next.updated_at };
    });
  }
}
