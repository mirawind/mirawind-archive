import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { canonicalJson } from "../../core/publication/manifest";
import type {
  SearchFtsRow,
  SearchShortRow,
  SearchSpool,
} from "../../core/publication/search-model";

const maximumBuildSpoolBytes = 512 * 1024 * 1024;

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("BUILD_SEARCH_SPOOL_INVALID");
  }
  return value as Readonly<Record<string, unknown>>;
}

export async function readBuildSearchSpool(path: string): Promise<SearchSpool> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > maximumBuildSpoolBytes) {
    throw new Error("BUILD_SEARCH_SPOOL_LIMIT");
  }
  const text = await readFile(path, "utf8");
  const ftsRows: SearchFtsRow[] = [];
  const shortRows: SearchShortRow[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const item = record(JSON.parse(line));
    if (Object.keys(item).length !== 2 || !("row" in item)) {
      throw new Error("BUILD_SEARCH_SPOOL_INVALID");
    }
    if (item.kind === "fts") {
      ftsRows.push(record(item.row) as unknown as SearchFtsRow);
    } else if (item.kind === "short") {
      shortRows.push(record(item.row) as unknown as SearchShortRow);
    } else {
      throw new Error("BUILD_SEARCH_SPOOL_INVALID");
    }
    if (ftsRows.length > 1_000_000 || shortRows.length > 100_000) {
      throw new Error("SEARCH_ROW_LIMIT");
    }
  }
  const payload = Object.freeze({
    ftsRows: Object.freeze(ftsRows),
    schemaVersion: 1 as const,
    shortRows: Object.freeze(shortRows),
  });
  return Object.freeze({
    ...payload,
    digest: createHash("sha256").update(canonicalJson(payload)).digest("hex"),
  });
}
