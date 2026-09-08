import type Database from "better-sqlite3";

import type {
  BookVersionPresentation,
  BookVersionPresentationWriter,
} from "@/modules/catalog/application/catalog-api";
import { withImmediateTransaction } from "@/platform/sqlite/immediate-transaction";
import type { SearchSpool } from "../../core/publication/search-model";
import { SearchIndexRepository } from "./search-index";
import type {
  BookVersionRecord,
  BookVersionState,
} from "../../application/version-record";

interface VersionRow {
  blocking_diagnostic_count: number;
  book_id: number;
  compiler_version: string;
  complete_at: number;
  source_updated_at: number;
  created_by_job_id: string;
  id: string;
  manifest_schema_version: number;
  manifest_sha256: string;
  preview_version: string;
  predecessor_version_id: string | null;
  published_at: number | null;
  reclaimed_at: number | null;
  renderer_version: string;
  reader_version: string;
  semantic_digest: string;
  import_id: string;
  state: BookVersionState;
  verified_at: number | null;
  version_rel_path: string;
  version_marker_sha256: string;
}

function mapVersion(row: VersionRow): BookVersionRecord {
  return Object.freeze({
    bookId: row.book_id,
    blockingDiagnosticCount: row.blocking_diagnostic_count,
    compilerVersion: row.compiler_version,
    completeAtMs: row.complete_at,
    sourceUpdatedAt: row.source_updated_at,
    createdByJobId: row.created_by_job_id,
    id: row.id,
    manifestSchemaVersion: row.manifest_schema_version,
    manifestSha256: row.manifest_sha256,
    previewVersion: row.preview_version,
    predecessorVersionId: row.predecessor_version_id,
    publishedAtMs: row.published_at,
    reclaimedAtMs: row.reclaimed_at,
    rendererVersion: row.renderer_version,
    readerVersion: row.reader_version,
    semanticDigest: row.semantic_digest,
    importId: row.import_id,
    state: row.state,
    verifiedAtMs: row.verified_at,
    versionRelativePath: row.version_rel_path,
    versionMarkerSha256: row.version_marker_sha256,
  });
}

export class VersionRepository {
  constructor(private readonly database: Database.Database) {}

  find(versionId: string): BookVersionRecord | null {
    const row = this.database
      .prepare("SELECT * FROM book_versions WHERE id = ?")
      .get(versionId) as VersionRow | undefined;
    return row ? mapVersion(row) : null;
  }

  require(versionId: string): BookVersionRecord {
    const version = this.find(versionId);
    if (!version) throw new Error("BOOK_VERSION_NOT_FOUND");
    return version;
  }

  listForBook(bookId: number): readonly BookVersionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM book_versions
         WHERE book_id = ?
         ORDER BY complete_at DESC, id DESC`,
      )
      .all(bookId) as VersionRow[];
    return Object.freeze(rows.map(mapVersion));
  }

  listAll(): readonly BookVersionRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM book_versions ORDER BY book_id, complete_at, id")
      .all() as VersionRow[];
    return Object.freeze(rows.map(mapVersion));
  }

  listPresentationReconciliationCandidates(): readonly BookVersionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT book_versions.*
         FROM book_versions
         JOIN books ON books.id = book_versions.book_id
         WHERE book_versions.reclaimed_at IS NULL
           AND books.deletion_requested_at IS NULL
           AND book_versions.state IN ('ready', 'published', 'superseded')
         ORDER BY book_versions.book_id, book_versions.complete_at,
                  book_versions.id`,
      )
      .all() as VersionRow[];
    return Object.freeze(rows.map(mapVersion));
  }

  markCorrupt(versionId: string): BookVersionRecord {
    const changed = this.database
      .prepare(
        `UPDATE book_versions SET state = 'corrupt'
         WHERE id = ? AND state <> 'corrupt'`,
      )
      .run(versionId);
    if (changed.changes > 1) throw new Error("VERSION_CORRUPT_UPDATE_INVALID");
    return this.require(versionId);
  }

  markVerified(versionId: string, nowMs: number): BookVersionRecord {
    const changed = this.database
      .prepare(
        `UPDATE book_versions SET verified_at = ?
         WHERE id = ? AND state <> 'corrupt'`,
      )
      .run(nowMs, versionId);
    if (changed.changes !== 1) throw new Error("VERSION_VERIFY_UPDATE_INVALID");
    return this.require(versionId);
  }

  promoteRecoveredVersion(input: {
    readonly bookId: number;
    readonly nowMs: number;
    readonly versionId: string;
  }): BookVersionRecord {
    const changed = this.database
      .prepare(
        `UPDATE book_versions
         SET state = 'published', verified_at = ?
         WHERE id = ? AND book_id = ? AND state = 'superseded'`,
      )
      .run(input.nowMs, input.versionId, input.bookId);
    if (changed.changes !== 1) {
      throw new Error("VERSION_ROLLBACK_PROMOTION_FAILED");
    }
    return this.require(input.versionId);
  }

  registerReadyWithSearch(input: {
    readonly bookId: number;
    readonly blockingDiagnosticCount?: number;
    readonly compilerVersion: string;
    readonly completeAtMs: number;
    readonly sourceUpdatedAt: number;
    readonly createdByJobId: string;
    readonly expectedSearchBlockIds: readonly string[];
    readonly manifestSchemaVersion: number;
    readonly manifestSha256: string;
    readonly previewVersion: string;
    readonly predecessorVersionId: string | null;
    readonly presentation: BookVersionPresentation;
    readonly presentationWriter: BookVersionPresentationWriter;
    readonly rendererVersion: string;
    readonly readerVersion: string;
    readonly semanticDigest: string;
    readonly importId: string;
    readonly spool: SearchSpool;
    readonly versionId: string;
    readonly versionRelativePath: string;
    readonly versionMarkerSha256: string;
  }): BookVersionRecord {
    if (!/^[a-f0-9]{64}$/u.test(input.manifestSha256)) {
      throw new Error("MANIFEST_SHA256_INVALID");
    }
    return withImmediateTransaction(this.database, () => {
      if (
        input.presentation.versionId !== input.versionId ||
        input.presentation.bookId !== input.bookId ||
        input.presentation.sourceUpdatedAt !== input.sourceUpdatedAt ||
        input.spool.ftsRows.some(
          (row) =>
            row.bookId !== input.bookId || row.versionId !== input.versionId,
        ) ||
        input.spool.shortRows.some(
          (row) =>
            row.bookId !== input.bookId || row.versionId !== input.versionId,
        )
      ) {
        throw new Error("SEARCH_CAPTURE_MISMATCH");
      }
      this.database
        .prepare(
          `INSERT INTO book_versions (
            id, book_id, import_id, source_updated_at, predecessor_version_id,
            state, version_rel_path, manifest_schema_version, manifest_sha256,
            version_marker_sha256, semantic_digest, compiler_version,
            renderer_version, preview_version, reader_version,
            blocking_diagnostic_count, complete_at, published_at,
            verified_at, created_by_job_id
          ) VALUES (
            ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            NULL, NULL, ?
          )`,
        )
        .run(
          input.versionId,
          input.bookId,
          input.importId,
          input.sourceUpdatedAt,
          input.predecessorVersionId,
          input.versionRelativePath,
          input.manifestSchemaVersion,
          input.manifestSha256,
          input.versionMarkerSha256,
          input.semanticDigest,
          input.compilerVersion,
          input.rendererVersion,
          input.previewVersion,
          input.readerVersion,
          input.blockingDiagnosticCount ?? 0,
          input.completeAtMs,
          input.createdByJobId,
        );
      input.presentationWriter.insert(input.presentation);
      new SearchIndexRepository(this.database).insertAndValidate({
        expectedBlockIds: input.expectedSearchBlockIds,
        spool: input.spool,
      });
      const jobUpdated = this.database
        .prepare(
          `UPDATE jobs SET version_id = ?
           WHERE id = ? AND kind = 'build_book'
             AND version_id = ?`,
        )
        .run(input.versionId, input.createdByJobId, input.versionId);
      if (jobUpdated.changes !== 1) throw new Error("VERSION_JOB_MISMATCH");
      return this.require(input.versionId);
    });
  }
}
