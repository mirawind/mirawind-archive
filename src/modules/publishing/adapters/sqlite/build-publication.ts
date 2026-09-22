import type Database from "better-sqlite3";
import { SafeApplicationError } from "@/domain/errors";
import type {
  BuildPublicationCapture,
  BuildPublicationPort,
  PublishedBuild,
} from "../../application/commands/publish-build";
import { withImmediateTransaction } from "@/platform/sqlite/immediate-transaction";
import { DocumentRepository } from "./documents";

interface PublicationRow {
  book_id: number;
  build_job_id: string;
  source_updated_at: number;
  import_id: string;
  draft_import_id: string | null;
  version_id: string;
  version_state: string;
  current_version_id: string | null;
  predecessor_version_id: string | null;
  published_at: number | null;
  blocking_diagnostic_count: number;
  alias: string | null;
}
export type BuildPromotionCrashPoint =
  "after_version_before_book" | "after_book_before_audit" | "after_commit";
export type BuildPromotionCrashPointInjector = (
  point: BuildPromotionCrashPoint,
) => void;
function stale(): never {
  throw new SafeApplicationError(
    "PUBLICATION_STALE",
    "The ready preview no longer matches the draft.",
    409,
  );
}
export class BuildPublicationRepository implements BuildPublicationPort {
  constructor(
    private readonly database: Database.Database,
    private readonly crashPoint?: BuildPromotionCrashPointInjector,
  ) {}
  private require(input: {
    bookId: number;
    buildId: string;
    expectedUpdatedAt: number;
  }): PublicationRow {
    new DocumentRepository(this.database).requireTimestamp(
      input.bookId,
      input.expectedUpdatedAt,
    );
    const row = this.database
      .prepare(
        "SELECT books.id AS book_id,books.current_version_id,books.draft_import_id,version.id AS version_id,version.state AS version_state,version.predecessor_version_id,version.published_at,version.source_updated_at,version.import_id,version.blocking_diagnostic_count,version.created_by_job_id AS build_job_id,presentation.alias FROM books JOIN book_versions version ON version.book_id=books.id AND version.id=? AND version.reclaimed_at IS NULL AND version.id=(SELECT version_id FROM jobs WHERE jobs.book_id=books.id AND kind='build_book' ORDER BY jobs.rowid DESC LIMIT 1) JOIN book_version_presentations presentation ON presentation.version_id=version.id WHERE books.id=? AND books.deletion_requested_at IS NULL",
      )
      .get(input.buildId, input.bookId) as PublicationRow | undefined;
    if (
      !row ||
      row.source_updated_at !== input.expectedUpdatedAt ||
      row.draft_import_id !== row.import_id ||
      row.blocking_diagnostic_count !== 0 ||
      !["ready", "published"].includes(row.version_state) ||
      (row.version_state === "ready" &&
        row.predecessor_version_id !== row.current_version_id) ||
      (row.version_state === "published" &&
        row.version_id !== row.current_version_id)
    )
      stale();
    return row;
  }
  capture(input: {
    readonly bookId: number;
    readonly expectedUpdatedAt: number;
    readonly buildId: string;
  }): BuildPublicationCapture {
    const row = this.require(input);
    return {
      bookId: row.book_id,
      sourceUpdatedAt: row.source_updated_at,
      importId: row.import_id,
      versionId: row.version_id,
      buildId: row.version_id,
    };
  }
  promote(input: {
    readonly actorUserId: string | null;
    readonly bookId: number;
    readonly expectedUpdatedAt: number;
    readonly expectedVersionId: string;
    readonly buildId: string;
    readonly nowMs: number;
  }): PublishedBuild {
    const published = withImmediateTransaction(this.database, () => {
      const row = this.require(input);
      if (row.version_id !== input.expectedVersionId) stale();
      if (row.version_state === "published") {
        if (row.published_at === null)
          throw new Error("PUBLICATION_TIMESTAMP_MISSING");
        return {
          publishedAtMs: row.published_at,
          state: "published" as const,
          versionId: row.version_id,
        };
      }
      if (row.current_version_id !== null) {
        const changed = this.database
          .prepare(
            "UPDATE book_versions SET state='superseded',retired_at=? WHERE id=? AND book_id=? AND state='published'",
          )
          .run(input.nowMs, row.current_version_id, row.book_id);
        if (changed.changes !== 1)
          throw new Error("PUBLICATION_OLD_STATE_INVALID");
      }
      const promoted = this.database
        .prepare(
          "UPDATE book_versions SET state='published',published_at=?,verified_at=?,retired_at=NULL WHERE id=? AND book_id=? AND state='ready'",
        )
        .run(input.nowMs, input.nowMs, row.version_id, row.book_id);
      if (promoted.changes !== 1)
        throw new Error("PUBLICATION_READY_STATE_INVALID");
      this.crashPoint?.("after_version_before_book");
      const book = this.database
        .prepare(
          "UPDATE books SET current_version_id=?,alias=?,unavailable_reason=NULL,updated_at=? WHERE id=? AND current_version_id IS ? AND deletion_requested_at IS NULL",
        )
        .run(
          row.version_id,
          row.alias,
          input.nowMs,
          row.book_id,
          row.current_version_id,
        );
      if (book.changes !== 1) throw new Error("PUBLICATION_BOOK_CAS_FAILED");
      this.crashPoint?.("after_book_before_audit");
      this.database
        .prepare(
          "INSERT INTO audit_events (actor_user_id,action,book_id,version_id,job_id,safe_metadata_json,created_at) VALUES (?,'book.published',?,?,?,?,?)",
        )
        .run(
          input.actorUserId,
          row.book_id,
          row.version_id,
          row.build_job_id,
          JSON.stringify({ source_updated_at: row.source_updated_at }),
          input.nowMs,
        );
      return {
        publishedAtMs: input.nowMs,
        state: "published" as const,
        versionId: row.version_id,
      };
    });
    this.crashPoint?.("after_commit");
    return published;
  }
}
