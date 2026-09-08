import { createHash } from "node:crypto";

export interface BookDeletionTokenInput {
  readonly alias: string | null;
  readonly bookId: number;
  readonly currentVersionId: string | null;
  readonly draftImportId: string | null;
  readonly title: string;
  readonly updatedAtMs: number;
}

function titleDigest(title: string): string {
  return createHash("sha256")
    .update(title.normalize("NFC"), "utf8")
    .digest("base64url");
}

export function createBookDeletionToken(input: BookDeletionTokenInput): string {
  const hash = createHash("sha256");
  for (const part of [
    "book-permanent-deletion-v2",
    String(input.bookId),
    String(input.updatedAtMs),
    input.alias ?? "",
    input.draftImportId ?? "",
    input.currentVersionId ?? "",
    titleDigest(input.title),
  ]) {
    const bytes = Buffer.from(part, "utf8");
    hash.update(`${bytes.length}:`);
    hash.update(bytes);
  }
  return `"${hash.digest("base64url")}"`;
}

export function normalizeMutationToken(value: string): string | null {
  if (
    value.length < 4 ||
    value.length > 200 ||
    !/^"[A-Za-z0-9_-]{20,100}"$/u.test(value)
  ) {
    return null;
  }
  return value;
}
