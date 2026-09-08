import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import type { AuthorizationDecision } from "@/http/authorization/admin-guard";
import { authorizeBookResource } from "@/http/authorization/book-guard";
import { SafeApplicationError } from "@/domain/errors";
import type {
  AdministratorLibraryPage,
  BookDetails,
  PublicLibraryEntry,
  PublicLibraryView,
} from "../../application/library-model";
import { createBookDeletionToken } from "../../core/book-deletion-token";

const maximumPublicEntries = 5_000;
const maximumAuthors = 100;
const maximumDescriptionCharacters = 10_000;
const maximumOriginals = 100;
const bookAliasPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

interface PresentationMetadata {
  readonly authors: readonly string[];
  readonly contributors: readonly string[];
  readonly description: string | null;
  readonly language: string | null;
  readonly subtitle: string | null;
}

interface PublicLibraryRow {
  alias: string | null;
  book_id: number;
  cover_resource_id: string | null;
  first_page_alias: string | null;
  first_page_id: number;
  metadata_json: string;
  projection_sha256: string;
  title: string;
  version_id: string;
}

interface DetailsRow extends PublicLibraryRow {
  access: "private" | "public";
  current_version_id: string | null;
  projection_book_id: number | null;
  projection_version_id: string | null;
  import_id: string | null;
  state: "corrupt" | "published" | "ready" | "superseded" | null;
  toc_entry_count: number | null;
  toc_preview_json: string | null;
  unavailable_reason: string | null;
}

interface TocRow {
  readonly block_id: string;
  readonly level: number;
  readonly number: string | null;
  readonly page_id: number;
  readonly title: string;
}

function hidden(): never {
  throw new SafeApplicationError(
    "NOT_FOUND",
    "The requested resource was not found.",
    404,
  );
}

function unavailable(): never {
  throw new SafeApplicationError(
    "BOOK_UNAVAILABLE",
    "This book is temporarily unavailable.",
    503,
  );
}

function boundedString(
  value: unknown,
  maximumCharacters: number,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? [...trimmed].slice(0, maximumCharacters).join("") : null;
}

function boundedStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value.slice(0, maximumAuthors).flatMap((item) => {
      const text = boundedString(item, 500);
      return text ? [text] : [];
    }),
  );
}

function parseMetadata(json: string): PresentationMetadata {
  const value = JSON.parse(json) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PRESENTATION_METADATA_INVALID");
  }
  const metadata = value as Readonly<Record<string, unknown>>;
  return Object.freeze({
    authors: boundedStrings(metadata.authors),
    contributors: boundedStrings(metadata.contributors),
    description: boundedString(
      metadata.description,
      maximumDescriptionCharacters,
    ),
    language: boundedString(metadata.language, 100),
    subtitle: boundedString(metadata.subtitle, 500),
  });
}

function canonicalBookKey(bookId: number, alias: string | null): string {
  return alias ?? String(bookId);
}

function pageKey(pageId: number, alias: string | null): string {
  return alias ?? String(pageId);
}

function mapPublicEntry(row: PublicLibraryRow): PublicLibraryEntry {
  const metadata = parseMetadata(row.metadata_json);
  const bookKey = canonicalBookKey(row.book_id, row.alias);
  return Object.freeze({
    authors: metadata.authors,
    bookId: row.book_id,
    bookKey,
    coverUrl: row.cover_resource_id
      ? `/books/${bookKey}/assets/${row.version_id}/${row.cover_resource_id}`
      : null,
    detailsUrl: `/books/${bookKey}`,
    presentationDigest: row.projection_sha256,
    startUrl: `/read/${bookKey}/${pageKey(
      row.first_page_id,
      row.first_page_alias,
    )}`,
    title: row.title,
    versionId: row.version_id,
  });
}

function digestLibrary(entries: readonly PublicLibraryEntry[]): string {
  const hash = createHash("sha256").update("library-view-v1\0");
  for (const entry of entries) {
    hash.update(
      `${entry.bookId}\0${entry.versionId}\0${entry.bookKey}\0${entry.presentationDigest}\0`,
    );
  }
  return hash.digest("base64url");
}

function keyPredicate(bookKey: string): {
  readonly sql: "books.alias = ?" | "books.id = ?";
  readonly value: number | string;
} {
  if (/^[1-9][0-9]*$/u.test(bookKey)) {
    const id = Number(bookKey);
    if (Number.isSafeInteger(id)) return { sql: "books.id = ?", value: id };
  }
  if (bookAliasPattern.test(bookKey) && bookKey.length <= 120) {
    return { sql: "books.alias = ?", value: bookKey };
  }
  return hidden();
}

export class LibraryService {
  constructor(private readonly database: Database.Database) {}

  publicLibrary(
    input: {
      readonly limit?: number;
    } = {},
  ): PublicLibraryView {
    const limit = input.limit ?? maximumPublicEntries;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > maximumPublicEntries
    ) {
      throw new Error("PUBLIC_LIBRARY_LIMIT_INVALID");
    }
    const detectOverflow = input.limit === undefined;
    const rows = this.database
      .prepare(
        `SELECT books.id AS book_id, presentation.alias,
                versions.id AS version_id, presentation.title,
                presentation.metadata_json,
                presentation.cover_resource_id,
                presentation.first_page_id,
                presentation.first_page_alias,
                presentation.projection_sha256
         FROM books
         JOIN book_versions AS versions
           ON versions.id = books.current_version_id
          AND versions.book_id = books.id
          AND versions.state = 'published'
          AND versions.reclaimed_at IS NULL
         JOIN book_version_presentations AS presentation
           ON presentation.version_id = versions.id
          AND presentation.book_id = books.id
          AND presentation.source_updated_at = versions.source_updated_at
         WHERE books.access = 'public'
           AND books.unavailable_reason IS NULL
           AND books.deletion_requested_at IS NULL
         ORDER BY presentation.title COLLATE NOCASE, books.id
         LIMIT ?`,
      )
      .all(limit + (detectOverflow ? 1 : 0)) as PublicLibraryRow[];
    let hasUnavailableBooks = detectOverflow && rows.length > limit;
    const entries: PublicLibraryEntry[] = [];
    for (const row of rows.slice(0, limit)) {
      try {
        entries.push(mapPublicEntry(row));
      } catch {
        hasUnavailableBooks = true;
      }
    }
    const unavailableRow = this.database
      .prepare(
        `SELECT 1
         FROM books
         LEFT JOIN book_versions AS versions
           ON versions.id = books.current_version_id
          AND versions.book_id = books.id
          AND versions.state = 'published'
          AND versions.reclaimed_at IS NULL
         LEFT JOIN book_version_presentations AS presentation
           ON presentation.version_id = versions.id
          AND presentation.book_id = books.id
          AND presentation.source_updated_at = versions.source_updated_at
         WHERE books.access = 'public'
           AND books.deletion_requested_at IS NULL
           AND (
             books.unavailable_reason IS NOT NULL
             OR versions.id IS NULL
             OR presentation.version_id IS NULL
           )
         LIMIT 1`,
      )
      .get();
    hasUnavailableBooks ||= unavailableRow !== undefined;
    return Object.freeze({
      digest: digestLibrary(entries),
      entries: Object.freeze(entries),
      hasUnavailableBooks,
    });
  }

  administratorLibrary(input: {
    readonly afterBookId: number | null;
    readonly limit: number;
  }): AdministratorLibraryPage {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      (input.afterBookId !== null &&
        (!Number.isSafeInteger(input.afterBookId) || input.afterBookId < 1))
    ) {
      throw new SafeApplicationError(
        "LIBRARY_PAGINATION_INVALID",
        "The library pagination values are invalid.",
        400,
      );
    }
    const rows = this.database
      .prepare(
        `SELECT books.id, books.title_cache, books.access,
                books.alias AS mutable_alias, books.updated_at,
                books.draft_import_id,
                books.current_version_id,
                books.unavailable_reason,
                presentation.alias, presentation.first_page_id,
                presentation.first_page_alias,
                CASE WHEN versions.state = 'published'
                           AND versions.reclaimed_at IS NULL
                           AND presentation.version_id IS NOT NULL
                           AND books.unavailable_reason IS NULL
                     THEN 1 ELSE 0 END AS current_available
         FROM books
         LEFT JOIN book_versions AS versions
           ON versions.id = books.current_version_id
          AND versions.book_id = books.id
         LEFT JOIN book_version_presentations AS presentation
           ON presentation.version_id = versions.id
          AND presentation.book_id = books.id
         WHERE books.id > ?
           AND books.deletion_requested_at IS NULL
         ORDER BY books.id
         LIMIT ?`,
      )
      .all(input.afterBookId ?? 0, input.limit + 1) as {
      alias: string | null;
      current_available: 0 | 1;
      first_page_alias: string | null;
      first_page_id: number | null;
      id: number;
      mutable_alias: string | null;
      current_version_id: string | null;
      draft_import_id: string | null;
      title_cache: string;
      unavailable_reason: string | null;
      updated_at: number;
      access: "private" | "public";
    }[];
    const page = rows.slice(0, input.limit);
    return Object.freeze({
      entries: Object.freeze(
        page.map((row) => {
          const currentVersionAvailable =
            row.current_available === 1 && row.first_page_id !== null;
          const readingHref = currentVersionAvailable
            ? `/read/${canonicalBookKey(row.id, row.alias)}/${pageKey(
                row.first_page_id ?? 1,
                row.first_page_alias,
              )}`
            : null;
          const statusLabel = row.unavailable_reason
            ? "暂不可用"
            : !row.current_version_id
              ? "草稿"
              : row.access === "private"
                ? "私有"
                : "已发布";
          return Object.freeze({
            access: row.access,
            bookId: row.id,
            currentVersionAvailable,
            deletionMutationToken: createBookDeletionToken({
              alias: row.mutable_alias,
              bookId: row.id,
              currentVersionId: row.current_version_id,
              draftImportId: row.draft_import_id,
              title: row.title_cache,
              updatedAtMs: row.updated_at,
            }),
            managementHref: `/manage/books/${row.id}`,
            readingHref,
            statusLabel,
            title: row.title_cache,
          });
        }),
      ),
      nextBookId: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
    });
  }

  resolveDetails(input: {
    readonly administrator: AuthorizationDecision;
    readonly bookKey: string;
  }): BookDetails {
    const predicate = keyPredicate(input.bookKey);
    const row = this.database
      .prepare(
        `SELECT books.id AS book_id, books.access,
                books.unavailable_reason, books.current_version_id,
                versions.id AS version_id, versions.state,
                versions.import_id, presentation.version_id AS projection_version_id,
                presentation.book_id AS projection_book_id,
                presentation.alias, presentation.title,
                presentation.metadata_json,
                presentation.cover_resource_id,
                presentation.first_page_id,
                presentation.first_page_alias,
                presentation.toc_preview_json,
                presentation.toc_entry_count,
                presentation.projection_sha256
         FROM books
         LEFT JOIN book_versions AS versions
           ON versions.id = books.current_version_id
          AND versions.book_id = books.id
          AND versions.reclaimed_at IS NULL
         LEFT JOIN book_version_presentations AS presentation
           ON presentation.version_id = versions.id
          AND presentation.book_id = books.id
          AND presentation.source_updated_at = versions.source_updated_at
         WHERE ${predicate.sql}
           AND books.deletion_requested_at IS NULL
         LIMIT 1`,
      )
      .get(predicate.value) as DetailsRow | undefined;
    if (!row) return hidden();
    const access = authorizeBookResource({
      access: row.access,
      administrator: input.administrator,
      exists: true,
    });
    if (!access.allowed) return hidden();
    if (
      row.unavailable_reason ||
      !row.current_version_id ||
      !row.version_id ||
      row.state !== "published" ||
      !row.projection_version_id ||
      row.projection_book_id !== row.book_id ||
      !row.title ||
      !row.metadata_json ||
      !row.toc_preview_json ||
      !row.projection_sha256 ||
      row.first_page_id === null ||
      row.toc_entry_count === null
    ) {
      if (row.access === "public" || row.current_version_id) {
        return unavailable();
      }
      return hidden();
    }
    let metadata: PresentationMetadata;
    let toc: readonly TocRow[];
    try {
      metadata = parseMetadata(row.metadata_json);
      const value = JSON.parse(row.toc_preview_json) as unknown;
      if (!Array.isArray(value) || value.length > 200) {
        return unavailable();
      }
      toc = value as readonly TocRow[];
    } catch {
      return unavailable();
    }
    const entry = mapPublicEntry(row);
    const originals = this.database
      .prepare(
        `SELECT id, original_name, media_type, size_bytes
         FROM original_files
         WHERE book_id = ? AND import_id = ?
         ORDER BY original_name, id
         LIMIT ?`,
      )
      .all(row.book_id, row.import_id, maximumOriginals) as {
      id: string;
      media_type: string;
      original_name: string;
      size_bytes: number;
    }[];
    return Object.freeze({
      access: row.access,
      ...entry,
      contributors: metadata.contributors,
      description: metadata.description,
      language: metadata.language,
      originals: Object.freeze(
        originals.map((original) =>
          Object.freeze({
            href: `/books/${entry.bookKey}/originals/${original.id}`,
            label: original.original_name,
            mediaType: original.media_type,
            sizeBytes: original.size_bytes,
          }),
        ),
      ),
      subtitle: metadata.subtitle,
      toc: Object.freeze(
        toc.map((node) =>
          Object.freeze({
            href: `/read/${entry.bookKey}/${node.page_id}#${node.block_id}`,
            level: node.level,
            number: node.number,
            title: node.title,
          }),
        ),
      ),
      tocEntryCount: row.toc_entry_count,
      tocTruncated: row.toc_entry_count > toc.length,
    });
  }
}
