import { readFile } from "node:fs/promises";

import type Database from "better-sqlite3";

import type { AuthorizationDecision } from "@/http/authorization/admin-guard";
import {
  authorizeBookResource,
  type BookAccess,
  type VersionState,
} from "@/http/authorization/book-guard";
import { SafeApplicationError } from "@/domain/errors";
import { isOpaqueId } from "@/domain/ids";
import {
  sharedVersionArtifactIndex,
  type IndexedManifestPage,
  type VersionArtifactIndex,
  type VersionArtifactIndexCache,
} from "./version-artifact-index";
import type { StorageLayout } from "@/platform/filesystem/storage-layout";
import { resolveContainedPath } from "@/platform/filesystem/contained-path";
import {
  fileHandleWebStream,
  openVerifiedContainedFile,
} from "@/platform/filesystem/verified-file";

interface CurrentBookRow {
  access: BookAccess;
  current_version_id: string | null;
  id: number;
  manifest_sha256: string | null;
  presentation_alias: string | null;
  presentation_title: string | null;
  renderer_version: string | null;
  state: VersionState | null;
  version_rel_path: string | null;
}

interface VersionAssetRow extends CurrentBookRow {
  requested_manifest_sha256: string | null;
  requested_state: VersionState | null;
  requested_version_rel_path: string | null;
}

interface OriginalRow extends CurrentBookRow {
  file_id: string | null;
  media_type: string | null;
  original_name: string | null;
  sha256: string | null;
  size_bytes: number | null;
}

export interface ResolvedPublishedBook {
  readonly access: BookAccess;
  readonly alias: string | null;
  readonly audience: "administrator" | "anonymous";
  readonly bookId: number;
  readonly rendererVersion: string;
  readonly manifestSha256: string;
  readonly title: string;
  readonly versionId: string;
  readonly versionRelativePath: string;
}

export interface ResolvedPublishedPage extends ResolvedPublishedBook {
  readonly pageAlias: string | null;
  readonly pageId: number;
  readonly pageRelativePath: string;
  readonly pageTitle: string;
}

export interface ResolvedPublishedAsset extends ResolvedPublishedBook {
  readonly mediaType: string;
  readonly resourceId: string;
  readonly resourceRelativePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface ResolvedOriginalFile extends ResolvedPublishedBook {
  readonly fileId: string;
  readonly mediaType: string;
  readonly originalName: string;
  readonly originalRelativePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

const bookAliasPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const pageAliasPattern = bookAliasPattern;

export function resetPublishedManifestCacheForTests(): void {
  sharedVersionArtifactIndex.clear();
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

function keyPredicate(bookKey: string): {
  readonly sql: "books.alias = ?" | "books.id = ?";
  readonly value: number | string;
} {
  if (/^[1-9][0-9]*$/u.test(bookKey)) {
    const id = Number(bookKey);
    if (Number.isSafeInteger(id)) return { sql: "books.id = ?", value: id };
  } else if (bookAliasPattern.test(bookKey) && bookKey.length <= 120) {
    return { sql: "books.alias = ?", value: bookKey };
  }
  return hidden();
}

function mapCurrent(
  row: CurrentBookRow,
  administrator: AuthorizationDecision,
): ResolvedPublishedBook {
  const access = authorizeBookResource({
    access: row.access,
    administrator,
    exists: true,
  });
  if (!access.allowed) return hidden();
  if (
    !row.current_version_id ||
    !row.version_rel_path ||
    !row.manifest_sha256 ||
    !row.renderer_version ||
    !row.presentation_title ||
    row.state !== "published"
  ) {
    if (row.access === "public" || row.current_version_id) {
      return unavailable();
    }
    return hidden();
  }
  return Object.freeze({
    access: row.access,
    alias: row.presentation_alias,
    audience: access.audience,
    bookId: row.id,
    manifestSha256: row.manifest_sha256,
    rendererVersion: row.renderer_version,
    title: row.presentation_title,
    versionId: row.current_version_id,
    versionRelativePath: row.version_rel_path,
  });
}

function currentSelect(predicate: string): string {
  return `SELECT books.id, books.access,
                 books.current_version_id, book_versions.state,
                 book_versions.version_rel_path, book_versions.renderer_version,
                 book_versions.manifest_sha256,
                 presentation.alias AS presentation_alias,
                 presentation.title AS presentation_title
          FROM books
          LEFT JOIN book_versions
            ON book_versions.id = books.current_version_id
           AND book_versions.book_id = books.id
           AND book_versions.reclaimed_at IS NULL
          LEFT JOIN book_version_presentations AS presentation
            ON presentation.version_id = books.current_version_id
           AND presentation.book_id = books.id
          WHERE ${predicate}
            AND books.deletion_requested_at IS NULL
          LIMIT 1`;
}

export class PublishedBookService {
  constructor(
    private readonly database: Database.Database,
    private readonly layout: StorageLayout,
    private readonly artifactIndexes: VersionArtifactIndexCache = sharedVersionArtifactIndex,
  ) {}

  private async artifactIndex(
    book: ResolvedPublishedBook,
    versionRelativePath = book.versionRelativePath,
    versionId = book.versionId,
    manifestSha256 = book.manifestSha256,
  ): Promise<VersionArtifactIndex> {
    try {
      return await this.artifactIndexes.load({
        bookId: book.bookId,
        layout: this.layout,
        manifestSha256,
        versionId,
        versionRelativePath,
      });
    } catch {
      return unavailable();
    }
  }

  resolveCurrent(
    bookKey: string,
    administrator: AuthorizationDecision,
  ): ResolvedPublishedBook {
    const predicate = keyPredicate(bookKey);
    const row = this.database
      .prepare(currentSelect(predicate.sql))
      .get(predicate.value) as CurrentBookRow | undefined;
    if (!row) return hidden();
    return mapCurrent(row, administrator);
  }

  async resolvePage(input: {
    readonly administrator: AuthorizationDecision;
    readonly bookKey: string;
    readonly pageKey: string;
  }): Promise<ResolvedPublishedPage> {
    const book = this.resolveCurrent(input.bookKey, input.administrator);
    const artifacts = await this.artifactIndex(book);
    let page: IndexedManifestPage | undefined;
    if (/^[1-9][0-9]*$/u.test(input.pageKey)) {
      const pageId = Number(input.pageKey);
      if (Number.isSafeInteger(pageId)) {
        page = artifacts.pageById(pageId);
      }
    } else if (
      pageAliasPattern.test(input.pageKey) &&
      input.pageKey.length <= 120
    ) {
      page = artifacts.pageByAlias(input.pageKey);
    }
    if (!page) return hidden();
    return Object.freeze({
      ...book,
      pageAlias: page.alias ?? null,
      pageId: page.page_id,
      pageRelativePath: `${book.versionRelativePath}/${page.output_path}`,
      pageTitle: page.title,
    });
  }

  async readPageHtml(page: ResolvedPublishedPage): Promise<string> {
    try {
      return await readFile(
        await resolveContainedPath(this.layout.root, page.pageRelativePath),
        "utf8",
      );
    } catch {
      return unavailable();
    }
  }

  async resolveAsset(input: {
    readonly administrator: AuthorizationDecision;
    readonly bookKey: string;
    readonly resourceId: string;
    readonly versionId: string;
  }): Promise<ResolvedPublishedAsset> {
    if (
      !isOpaqueId("version", input.versionId) ||
      !isOpaqueId("resource", input.resourceId)
    ) {
      return hidden();
    }
    const predicate = keyPredicate(input.bookKey);
    const row = this.database
      .prepare(
        `SELECT books.id, books.access,
                books.current_version_id, current_version.state,
                current_version.version_rel_path,
                current_version.renderer_version,
                current_version.manifest_sha256,
                presentation.alias AS presentation_alias,
                presentation.title AS presentation_title,
                requested_version.state AS requested_state,
                requested_version.version_rel_path AS requested_version_rel_path,
                requested_version.manifest_sha256 AS requested_manifest_sha256
         FROM books
         LEFT JOIN book_versions AS current_version
           ON current_version.id = books.current_version_id
          AND current_version.book_id = books.id
          AND current_version.reclaimed_at IS NULL
         LEFT JOIN book_version_presentations AS presentation
           ON presentation.version_id = books.current_version_id
          AND presentation.book_id = books.id
         LEFT JOIN book_versions AS requested_version
           ON requested_version.id = ?
          AND requested_version.book_id = books.id
          AND requested_version.reclaimed_at IS NULL
         WHERE ${predicate.sql}
           AND books.deletion_requested_at IS NULL
         LIMIT 1`,
      )
      .get(input.versionId, predicate.value) as VersionAssetRow | undefined;
    if (!row) return hidden();
    const book = mapCurrent(row, input.administrator);
    const access = authorizeBookResource({
      access: row.access,
      administrator: input.administrator,
      exists: Boolean(row.requested_version_rel_path),
      ...(row.requested_state ? { versionState: row.requested_state } : {}),
    });
    if (
      !access.allowed ||
      !row.requested_version_rel_path ||
      !row.requested_manifest_sha256
    ) {
      return hidden();
    }
    const artifacts = await this.artifactIndex(
      book,
      row.requested_version_rel_path,
      input.versionId,
      row.requested_manifest_sha256,
    );
    const resource = artifacts.resourceById(input.resourceId);
    if (!resource) return hidden();
    return Object.freeze({
      ...book,
      mediaType: resource.media_type,
      resourceId: input.resourceId,
      resourceRelativePath: `books/${row.id}/${resource.output_path}`,
      sha256: resource.sha256,
      sizeBytes: resource.size,
      versionId: input.versionId,
      versionRelativePath: row.requested_version_rel_path,
    });
  }

  async readAssetBody(
    asset: ResolvedPublishedAsset,
  ): Promise<ReadableStream<Uint8Array>> {
    try {
      return fileHandleWebStream(
        await openVerifiedContainedFile({
          expectedSize: asset.sizeBytes,
          relativePath: asset.resourceRelativePath,
          root: this.layout.root,
        }),
      );
    } catch {
      return unavailable();
    }
  }

  resolveOriginal(input: {
    readonly administrator: AuthorizationDecision;
    readonly bookKey: string;
    readonly fileId: string;
  }): ResolvedOriginalFile {
    if (!isOpaqueId("file", input.fileId)) return hidden();
    const predicate = keyPredicate(input.bookKey);
    const row = this.database
      .prepare(
        `SELECT books.id, books.access,
                books.current_version_id, book_versions.state,
                book_versions.version_rel_path, book_versions.renderer_version,
                book_versions.manifest_sha256,
                presentation.alias AS presentation_alias,
                presentation.title AS presentation_title,
                original_files.id AS file_id, original_files.original_name,
                original_files.media_type, original_files.size_bytes,
                original_files.sha256
         FROM books
         LEFT JOIN book_versions
           ON book_versions.id = books.current_version_id
          AND book_versions.book_id = books.id
          AND book_versions.reclaimed_at IS NULL
         LEFT JOIN book_version_presentations AS presentation
           ON presentation.version_id = books.current_version_id
          AND presentation.book_id = books.id
         LEFT JOIN original_files
           ON original_files.id = ?
          AND original_files.book_id = books.id
          AND original_files.import_id = book_versions.import_id
         WHERE ${predicate.sql}
           AND books.deletion_requested_at IS NULL
         LIMIT 1`,
      )
      .get(input.fileId, predicate.value) as OriginalRow | undefined;
    if (!row) return hidden();
    const book = mapCurrent(row, input.administrator);
    if (
      !row.file_id ||
      !row.media_type ||
      !row.original_name ||
      !row.sha256 ||
      row.size_bytes === null
    ) {
      return hidden();
    }
    return Object.freeze({
      ...book,
      fileId: row.file_id,
      mediaType: row.media_type,
      originalName: row.original_name,
      originalRelativePath: `books/${book.bookId}/originals/${row.file_id}`,
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
    });
  }

  async readOriginalBody(
    original: ResolvedOriginalFile,
    range?: { readonly end: number; readonly start: number },
  ): Promise<ReadableStream<Uint8Array>> {
    try {
      return fileHandleWebStream(
        await openVerifiedContainedFile({
          expectedSize: original.sizeBytes,
          relativePath: original.originalRelativePath,
          root: this.layout.root,
        }),
        range,
      );
    } catch {
      return unavailable();
    }
  }
}
