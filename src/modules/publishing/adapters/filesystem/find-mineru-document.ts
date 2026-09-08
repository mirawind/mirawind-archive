import { readdir, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { contentLimits } from "../../core/content/book-document";

export interface MineruDocumentSelection {
  readonly document: { readonly path: string; readonly size: number } | null;
  readonly decision: "automatic" | "reject";
  readonly reason:
    | "mineru-v2"
    | "multiple-book-bundles"
    | "no-mineru-json"
    | "document-too-large";
}
export async function findMineruDocument(
  rootInput: string,
): Promise<MineruDocumentSelection> {
  const root = resolve(rootInput),
    pending = [root],
    paths: string[] = [];
  while (pending.length) {
    const directory = pending.pop();
    if (!directory) break;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (
        entry.isFile() &&
        /(?:^|_)content_list_v2\.json$/iu.test(entry.name)
      )
        paths.push(path);
    }
  }
  if (paths.length !== 1)
    return {
      document: null,
      decision: "reject",
      reason: paths.length ? "multiple-book-bundles" : "no-mineru-json",
    };
  const path = paths[0];
  if (!path) throw new Error("IMPORT_DOCUMENT_MISSING");
  const size = (await stat(path)).size;
  if (size > contentLimits.bytes)
    return { document: null, decision: "reject", reason: "document-too-large" };
  return {
    document: { path: relative(root, path).split(sep).join("/"), size },
    decision: "automatic",
    reason: "mineru-v2",
  };
}
