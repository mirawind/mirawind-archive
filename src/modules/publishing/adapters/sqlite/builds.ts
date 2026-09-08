import type Database from "better-sqlite3";
import { createOpaqueId } from "@/domain/ids";
import { withImmediateTransaction } from "@/platform/sqlite/immediate-transaction";
import { JobRepository, type JobRecord } from "./jobs";
import { VersionRepository } from "./versions";
import { DocumentRepository } from "./documents";
import { buildIdentities } from "../../application/commands/build-book";

export interface BuildRecord {
  readonly id: string;
  readonly bookId: number;
  readonly importId: string;
  readonly jobId: string;
  readonly sourceUpdatedAt: number;
  readonly state: "building" | "ready" | "failed" | "canceled" | "interrupted";
  readonly safeErrorCode: string | null;
  readonly previewUrl: string | null;
  readonly semanticDigest: string | null;
  readonly blockingDiagnosticCount: number | null;
}

export class BuildRepository {
  constructor(private readonly database: Database.Database) {}

  private fromJob(job: JobRecord): BuildRecord {
    if (
      !job.versionId ||
      !job.bookId ||
      !job.importId ||
      job.capturedSourceUpdatedAt === null
    )
      throw new Error("BUILD_RECORD_INVALID");
    const version = new VersionRepository(this.database).find(job.versionId);
    const ready =
      job.state === "succeeded" &&
      version &&
      version.state !== "corrupt" &&
      version.reclaimedAtMs === null;
    return {
      id: job.versionId,
      bookId: job.bookId,
      importId: job.importId,
      jobId: job.id,
      sourceUpdatedAt: job.capturedSourceUpdatedAt,
      state: ready
        ? "ready"
        : job.state === "queued" || job.state === "running"
          ? "building"
          : job.state === "succeeded"
            ? "failed"
            : job.state,
      safeErrorCode: ready ? null : job.errorCode,
      previewUrl: ready
        ? `/api/manage/books/${job.bookId}/preview/${job.versionId}/pages/1`
        : null,
      semanticDigest: version?.semanticDigest ?? null,
      blockingDiagnosticCount: version?.blockingDiagnosticCount ?? null,
    };
  }

  find(buildId: string): BuildRecord | null {
    const row = this.database
      .prepare(
        "SELECT id FROM jobs WHERE version_id=? AND kind='build_book' ORDER BY rowid DESC LIMIT 1",
      )
      .get(buildId) as { id: string } | undefined;
    const job = row && new JobRepository(this.database).get(row.id);
    return job ? this.fromJob(job) : null;
  }
  require(buildId: string): BuildRecord {
    const build = this.find(buildId);
    if (!build) throw new Error("BUILD_NOT_FOUND");
    return build;
  }
  findCurrent(bookId: number): BuildRecord | null {
    const row = this.database
      .prepare(
        "SELECT jobs.id FROM jobs JOIN books ON books.id=jobs.book_id WHERE jobs.book_id=? AND jobs.kind='build_book' AND books.deletion_requested_at IS NULL ORDER BY jobs.rowid DESC LIMIT 1",
      )
      .get(bookId) as { id: string } | undefined;
    const job = row && new JobRepository(this.database).get(row.id);
    return job ? this.fromJob(job) : null;
  }
  findReadable(buildId: string, bookId: number): BuildRecord | null {
    const result = this.find(buildId);
    return result?.bookId === bookId && result.state === "ready"
      ? result
      : null;
  }

  createForDocument(input: {
    bookId: number;
    importId: string;
    sourceUpdatedAt: number;
    nowMs: number;
    delayMs?: number;
  }): BuildRecord {
    return withImmediateTransaction(this.database, () => {
      const book = this.database
        .prepare(
          "SELECT current_version_id FROM books WHERE id=? AND deletion_requested_at IS NULL",
        )
        .get(input.bookId) as { current_version_id: string | null } | undefined;
      if (!book) throw new Error("BOOK_NOT_FOUND");
      const queued = this.database
        .prepare(
          "SELECT id,version_id FROM jobs WHERE book_id=? AND kind='build_book' AND state='queued'",
        )
        .get(input.bookId) as { id: string; version_id: string } | undefined;
      this.database
        .prepare(
          "UPDATE jobs SET cancellation_requested_at=COALESCE(cancellation_requested_at,?),error_code='BUILD_SUPERSEDED' WHERE book_id=? AND kind='build_book' AND state='running' AND captured_source_updated_at<>?",
        )
        .run(input.nowMs, input.bookId, input.sourceUpdatedAt);
      if (queued) {
        this.database
          .prepare(
            "UPDATE jobs SET captured_source_updated_at=?,captured_current_version_id=?,available_at=? WHERE id=? AND state='queued'",
          )
          .run(
            input.sourceUpdatedAt,
            book.current_version_id,
            input.nowMs + (input.delayMs ?? 0),
            queued.id,
          );
        return this.require(queued.version_id);
      }
      const running = this.database
        .prepare(
          "SELECT version_id FROM jobs WHERE book_id=? AND kind='build_book' AND state='running' AND captured_source_updated_at=? AND cancellation_requested_at IS NULL",
        )
        .get(input.bookId, input.sourceUpdatedAt) as
        { version_id: string } | undefined;
      if (running) return this.require(running.version_id);
      const versionId = createOpaqueId("version");
      const job = new JobRepository(this.database).create({
        bookId: input.bookId,
        importId: input.importId,
        kind: "build_book",
        versionId,
        capturedSourceUpdatedAt: input.sourceUpdatedAt,
        ...(book.current_version_id
          ? { capturedCurrentVersionId: book.current_version_id }
          : {}),
        nowMs: input.nowMs,
      });
      this.database
        .prepare(
          "UPDATE jobs SET captured_input_path=?,available_at=? WHERE id=?",
        )
        .run(
          `staging/${job.id}/input/book.json`,
          input.nowMs + (input.delayMs ?? 0),
          job.id,
        );
      return this.require(versionId);
    });
  }

  buildCommand(buildId: string) {
    const build = this.require(buildId);
    const job = new JobRepository(this.database).get(build.jobId);
    if (!job || job.state !== "running" || !job.capturedInputPath)
      throw new Error("BUILD_INPUT_INVALID");
    const previous = this.database
      .prepare(
        "SELECT id,version_marker_sha256 FROM book_versions WHERE book_id=? AND reclaimed_at IS NULL AND state IN ('ready','published','superseded') AND compiler_version=? ORDER BY complete_at DESC,rowid DESC LIMIT 1",
      )
      .get(build.bookId, buildIdentities.compiler) as
      { id: string; version_marker_sha256: string } | undefined;
    return {
      reuse: previous
        ? { id: previous.id, markerSha256: previous.version_marker_sha256 }
        : null,
      bookId: build.bookId,
      versionId: build.id,
      jobId: job.id,
      kind: "build_book" as const,
      importId: build.importId,
      sourceUpdatedAt: build.sourceUpdatedAt,
      capturedCurrentVersionId: job.capturedCurrentVersionId,
      inputRelativePath: job.capturedInputPath,
      resourceRootRelativePath: `books/${build.bookId}`,
      compilerIdentity: buildIdentities.compiler,
      previewIdentity: buildIdentities.preview,
      readerIdentity: buildIdentities.reader,
      rendererIdentity: buildIdentities.renderer,
    };
  }

  retry(
    job: JobRecord,
    input: {
      automatic: boolean;
      nowMs: number;
      idempotency?: { key: string; operation: string };
    },
  ): JobRecord {
    return withImmediateTransaction(this.database, () => {
      if (
        !job.bookId ||
        !job.versionId ||
        this.findCurrent(job.bookId)?.id !== job.versionId ||
        new DocumentRepository(this.database).timestamp(job.bookId) !==
          job.capturedSourceUpdatedAt
      )
        throw new Error("BUILD_RETRY_STALE");
      const book = this.database
        .prepare(
          "SELECT current_version_id FROM books WHERE id=? AND deletion_requested_at IS NULL",
        )
        .get(job.bookId) as { current_version_id: string | null } | undefined;
      if (!book) throw new Error("BOOK_NOT_FOUND");
      const retry = new JobRepository(this.database).retry(job.id, {
        ...input,
        nextAttempt: {
          capturedCurrentVersionId: book.current_version_id,
          versionId: createOpaqueId("version"),
        },
      });
      this.database
        .prepare("UPDATE jobs SET captured_input_path=? WHERE id=?")
        .run(`staging/${retry.id}/input/book.json`, retry.id);
      const result = new JobRepository(this.database).get(retry.id);
      if (!result) throw new Error("BUILD_RETRY_MISSING");
      return result;
    });
  }
}
