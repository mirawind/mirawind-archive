import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { SafeApplicationError } from "@/domain/errors";
import { withImmediateTransaction } from "@/platform/sqlite/immediate-transaction";
import {
  contentLimits,
  nextContentTimestamp,
  validateBookDocument,
  validateEditedRoot,
} from "../../core/content/book-document";
import type {
  BookDocument,
  ContentBlock,
  ListItem,
} from "../../core/content/book-document.generated";
import { contentEntries } from "../../core/content/content-tree";
import {
  editBookDocument,
  applyBookEdit,
  parseDraftEdit,
  type DraftEdit,
} from "../../core/content/edit-book";
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
  constructor(private readonly database: Database.Database) {}

  header(bookId: number): Omit<BookDocument, "blocks"> {
    const row = this.database
      .prepare(
        "SELECT document.* FROM book_documents document JOIN books ON books.id=document.book_id WHERE document.book_id=? AND books.deletion_requested_at IS NULL",
      )
      .get(bookId) as DocumentRow | undefined;
    if (!row) missing();
    const resources = this.database
      .prepare(
        "SELECT id,storage_rel_path,media_type FROM book_resources WHERE book_id=? ORDER BY rowid",
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
            "SELECT id,storage_rel_path AS path,size_bytes AS size,sha256,media_type FROM book_resources WHERE book_id=?",
          )
          .all(bookId);
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

  private writeBlocks(
    book: BookDocument,
    previous: ReadonlyMap<string, string>,
  ): void {
    for (const [ordinal, block] of book.blocks.entries()) {
      const json = JSON.stringify(block);
      if (previous.get(block.id) === json) continue;
      this.writeRoot(book.book_id, block, ordinal);
    }
  }

  private writeRoot(
    bookId: number,
    block: ContentBlock,
    ordinal: number,
  ): void {
    this.database
      .prepare(
        "INSERT INTO book_blocks(book_id,id,ordinal,type,content_json) VALUES (?,?,?,?,?) ON CONFLICT(book_id,id) DO UPDATE SET ordinal=excluded.ordinal,type=excluded.type,content_json=excluded.content_json",
      )
      .run(bookId, block.id, ordinal, block.type, JSON.stringify(block));
    this.database
      .prepare("DELETE FROM book_nodes WHERE book_id=? AND root_id=?")
      .run(bookId, block.id);
    const insert = this.database.prepare(
      "INSERT INTO book_nodes(book_id,id,root_id,kind) VALUES (?,?,?,?)",
    );
    for (const entry of contentEntries([block]))
      insert.run(bookId, entry.node.id, block.id, entry.kind);
  }

  private prepareRootEdit(
    bookId: number,
    patch: DraftEdit,
    expected: number,
    now: number,
  ) {
    if (!patch.block || Object.keys(patch).length !== 1) return null;
    const selected = patch.block;
    const captured = this.database
      .transaction(() => {
        const header = this.header(bookId);
        if (header.updated_at !== expected) conflict();
        const row = this.database
          .prepare(
            "SELECT block.ordinal,block.content_json FROM book_nodes node JOIN book_blocks block ON block.book_id=node.book_id AND block.id=node.root_id WHERE node.book_id=? AND node.id=?",
          )
          .get(bookId, selected.block_id) as
          { ordinal: number; content_json: string } | undefined;
        if (!row) missing();
        return {
          header,
          row,
          root: JSON.parse(row.content_json) as ContentBlock,
        };
      })
      .deferred();
    const oldEntries = [...contentEntries([captured.root])];
    if (oldEntries.some((entry) => entry.kind === "heading")) return null;
    const proposed = applyBookEdit(
      { ...captured.header, blocks: [captured.root] },
      patch,
    ).blocks[0];
    if (!proposed) missing();
    const entries = [...contentEntries([proposed])];
    if (entries.some((entry) => entry.kind === "heading")) return null;
    if (JSON.stringify(proposed) === captured.row.content_json)
      return {
        root: proposed,
        ordinal: captured.row.ordinal,
        updated_at: expected,
        changed: false,
      };
    const lookup = this.database.prepare(
      "SELECT kind FROM book_nodes WHERE book_id=? AND id=? AND root_id<>?",
    );
    const cache = new Map<string, string | null>();
    validateEditedRoot(
      proposed,
      new Set(captured.header.resources.map((resource) => resource.id)),
      (id) => {
        if (!cache.has(id))
          cache.set(
            id,
            (
              lookup.get(bookId, id, captured.root.id) as
                { kind: string } | undefined
            )?.kind ?? null,
          );
        return cache.get(id) ?? null;
      },
    );
    const total = this.database
      .prepare("SELECT count(*) AS count FROM book_nodes WHERE book_id=?")
      .get(bookId) as { count: number };
    if (total.count - oldEntries.length + entries.length > contentLimits.blocks)
      throw new SafeApplicationError(
        "BOOK_DOCUMENT_LIMIT_EXCEEDED",
        "The book exceeds the content limit.",
        400,
      );
    const newKinds = new Map(
      entries.map((entry) => [entry.node.id, entry.kind]),
    );
    const invalidated = oldEntries.flatMap((entry) =>
      !newKinds.has(entry.node.id)
        ? [{ id: entry.node.id, footnoteOnly: 0 }]
        : entry.kind === "footnote" &&
            newKinds.get(entry.node.id) !== "footnote"
          ? [{ id: entry.node.id, footnoteOnly: 1 }]
          : [],
    );
    if (
      invalidated.length &&
      this.database
        .prepare(
          "SELECT 1 FROM book_blocks block,json_tree(block.content_json) node,json_each(?) changed WHERE block.book_id=? AND block.id<>? AND node.value=json_extract(changed.value,'$.id') AND (node.key='target_id' OR (node.key='block_id' AND json_extract(changed.value,'$.footnoteOnly')=0)) LIMIT 1",
        )
        .get(JSON.stringify(invalidated), bookId, captured.root.id)
    )
      throw new SafeApplicationError(
        "BOOK_LINK_MISSING",
        "The edit would remove referenced content.",
        400,
      );
    const localOrder = new Map(
      entries.map((entry, index) => [entry.node.id, index]),
    );
    let previousRoot = -1,
      previousLocal = -1;
    for (const id of [
      captured.header.publishing.boundaries.body_start_block_id,
      captured.header.publishing.boundaries.appendix_start_block_id,
      captured.header.publishing.boundaries.backmatter_start_block_id,
    ]) {
      if (!id) continue;
      const local = localOrder.get(id);
      const ordinal =
        local !== undefined
          ? captured.row.ordinal
          : (
              this.database
                .prepare(
                  "SELECT block.ordinal FROM book_nodes node JOIN book_blocks block ON block.book_id=node.book_id AND block.id=node.root_id WHERE node.book_id=? AND node.id=? AND node.root_id<>?",
                )
                .get(bookId, id, captured.root.id) as
                { ordinal: number } | undefined
            )?.ordinal;
      if (
        ordinal === undefined ||
        ordinal < previousRoot ||
        (ordinal === previousRoot &&
          local !== undefined &&
          local <= previousLocal)
      )
        throw new SafeApplicationError(
          "BOOK_BOUNDARY_INVALID",
          "The edit would invalidate a content boundary.",
          400,
        );
      previousRoot = ordinal;
      previousLocal = local ?? -1;
    }
    return {
      root: proposed,
      ordinal: captured.row.ordinal,
      updated_at: nextContentTimestamp(expected, now),
      changed: true,
    };
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
    const patch: DraftEdit = parseDraftEdit(input.patch);
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
    const rootEdit = this.prepareRootEdit(
      input.bookId,
      patch,
      input.expectedUpdatedAt,
      input.nowMs,
    );
    const current = rootEdit ? null : this.read(input.bookId);
    let next: BookDocument | Pick<BookDocument, "book_id" | "updated_at">;
    if (current)
      next = editBookDocument(
        current,
        patch,
        input.expectedUpdatedAt,
        input.nowMs,
      );
    else if (rootEdit)
      next = { book_id: input.bookId, updated_at: rootEdit.updated_at };
    else throw new Error("DRAFT_EDIT_MISSING");
    const previous = new Map(
      current?.blocks.map((block) => [block.id, JSON.stringify(block)]) ?? [],
    );
    return withImmediateTransaction(this.database, () => {
      const prior = receipt();
      if (prior) return { updated_at: prior.updated_at };
      this.requireTimestamp(input.bookId, input.expectedUpdatedAt);
      if (rootEdit?.changed) {
        this.writeRoot(input.bookId, rootEdit.root, rootEdit.ordinal);
        this.database
          .prepare("UPDATE book_documents SET updated_at=? WHERE book_id=?")
          .run(next.updated_at, input.bookId);
        input.onChanged(next);
      } else if (!rootEdit && next !== current && "blocks" in next) {
        this.writeBlocks(next, previous);
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
