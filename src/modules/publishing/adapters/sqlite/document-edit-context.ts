import type Database from "better-sqlite3";
import type { ContentBlock } from "../../core/content/book-document.generated";
import type { DocumentHeader } from "../../core/content/book-document";
import type {
  EditContext,
  EditableRoot,
  IndexedContent,
} from "../../core/content/prepare-edit";

export function documentEditContext(
  database: Database.Database,
  header: DocumentHeader,
): EditContext {
  const bookId = header.book_id;
  const roots = new Map<string, EditableRoot>(),
    nodes = new Map<string, IndexedContent | null>();
  const nodeQuery = database.prepare(
    "SELECT node.kind,node.root_id,block.ordinal,node.rowid AS node_ordinal FROM book_nodes node JOIN book_blocks block ON block.book_id=node.book_id AND block.id=node.root_id WHERE node.book_id=? AND node.id=?",
  );
  const rootQuery = database.prepare(
    "SELECT ordinal,content_json FROM book_blocks WHERE book_id=? AND id=?",
  );
  const node = (id: string): IndexedContent | null => {
    if (!nodes.has(id)) {
      const row = nodeQuery.get(bookId, id) as
        | {
            kind: string;
            root_id: string;
            ordinal: number;
            node_ordinal: number;
          }
        | undefined;
      nodes.set(
        id,
        row
          ? {
              kind: row.kind,
              rootId: row.root_id,
              position: {
                rootOrdinal: row.ordinal,
                nodeOrdinal: row.node_ordinal,
              },
            }
          : null,
      );
    }
    return nodes.get(id) ?? null;
  };
  const root = (id: string): EditableRoot | null => {
    if (!roots.has(id)) {
      const row = rootQuery.get(bookId, id) as
        { ordinal: number; content_json: string } | undefined;
      if (!row) return null;
      const block = JSON.parse(row.content_json) as ContentBlock;
      roots.set(id, { ordinal: row.ordinal, block });
    }
    return roots.get(id) ?? null;
  };
  return {
    header,
    rootForBlock(id) {
      const indexed = node(id);
      return indexed ? root(indexed.rootId) : null;
    },
    node,
    headingRoots() {
      const ids = database
        .prepare(
          "SELECT DISTINCT root_id FROM book_nodes WHERE book_id=? AND kind='heading'",
        )
        .pluck()
        .all(bookId) as string[];
      return ids
        .flatMap((id) => {
          const value = root(id);
          return value ? [value] : [];
        })
        .sort((a, b) => a.ordinal - b.ordinal);
    },
    nodeCount: () =>
      database
        .prepare("SELECT count(*) FROM book_nodes WHERE book_id=?")
        .pluck()
        .get(bookId) as number,
    referencesTo(ids, excludedRoots) {
      return database
        .prepare(
          "SELECT DISTINCT node.value AS id,node.key AS field FROM book_blocks block,json_tree(block.content_json) node WHERE block.book_id=? AND block.id NOT IN (SELECT value FROM json_each(?)) AND node.key IN ('target_id','block_id') AND node.value IN (SELECT value FROM json_each(?))",
        )
        .all(bookId, JSON.stringify(excludedRoots), JSON.stringify(ids)) as {
        id: string;
        field: "block_id" | "target_id";
      }[];
    },
  };
}
