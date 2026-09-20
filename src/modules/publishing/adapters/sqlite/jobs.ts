import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import { createOpaqueId } from "@/domain/ids";
import {
  assertJobProgressUpdate,
  assertJobTransition,
  assertJobPhase,
  isJobProgress,
  isUserJobKind,
  isTerminalJobState,
  type JobProgress,
  type JobErrorClass,
  type JobKind,
  type QueueObservation,
  type JobState,
  type TerminalJobState,
  type UserJobKind,
} from "../../application/job-state";

interface JobRow {
  attempt: number;
  automatic_retry_count: number;
  book_id: number | null;
  captured_source_updated_at: number | null;
  captured_current_version_id: string | null;
  captured_input_path: string | null;
  created_at: number;
  error_class: JobErrorClass | null;
  error_code: string | null;
  error_detail_json: string | null;
  finished_at: number | null;
  heartbeat_at: number | null;
  id: string;
  import_id: string | null;
  kind: JobKind;
  lease_owner: string | null;
  lease_until: number | null;
  phase: string;
  progress_json: string;
  cancellation_requested_at: number | null;
  retry_of_job_id: string | null;
  started_at: number | null;
  state: JobState;
  version_id: string | null;
}

export interface JobRecord {
  readonly attempt: number;
  readonly automaticRetryCount: number;
  readonly bookId: number | null;
  readonly capturedSourceUpdatedAt: number | null;
  readonly capturedCurrentVersionId: string | null;
  readonly capturedInputPath: string | null;
  readonly createdAtMs: number;
  readonly errorClass: JobErrorClass | null;
  readonly errorCode: string | null;
  readonly errorDetail: Readonly<Record<string, unknown>> | null;
  readonly finishedAtMs: number | null;
  readonly heartbeatAtMs: number | null;
  readonly id: string;
  readonly importId: string | null;
  readonly kind: JobKind;
  readonly leaseOwner: string | null;
  readonly leaseUntilMs: number | null;
  readonly phase: string;
  readonly progress: JobProgress;
  readonly cancellationRequestedAtMs: number | null;
  readonly retryOfJobId: string | null;
  readonly startedAtMs: number | null;
  readonly state: JobState;
  readonly versionId: string | null;
}

export type UserJobRecord = Omit<JobRecord, "kind"> & {
  readonly kind: UserJobKind;
};

export interface CreateJobInput {
  readonly bookId?: number;
  readonly capturedSourceUpdatedAt?: number;
  readonly capturedCurrentVersionId?: string;
  readonly capturedInputPath?: string;
  readonly idempotency?: {
    readonly key: string;
    readonly operation: string;
  };
  readonly importId?: string;
  readonly kind: UserJobKind;
  readonly nowMs?: number;
  readonly phase?: string;
  readonly versionId?: string;
}

function parseBoundedObject(
  value: string | null,
): Readonly<Record<string, unknown>> | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JOB_JSON_NOT_OBJECT");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function mapJob(row: JobRow): JobRecord {
  const parsedProgress = parseBoundedObject(row.progress_json);
  const progress = isJobProgress(parsedProgress)
    ? parsedProgress
    : {
        completed: 0,
        processed_bytes: null,
        total: null,
        unit: "steps" as const,
      };
  return {
    attempt: row.attempt,
    automaticRetryCount: row.automatic_retry_count,
    bookId: row.book_id,
    capturedSourceUpdatedAt: row.captured_source_updated_at,
    capturedCurrentVersionId: row.captured_current_version_id,
    capturedInputPath: row.captured_input_path,
    createdAtMs: row.created_at,
    errorClass: row.error_class,
    errorCode: row.error_code,
    errorDetail: parseBoundedObject(row.error_detail_json),
    finishedAtMs: row.finished_at,
    heartbeatAtMs: row.heartbeat_at,
    id: row.id,
    importId: row.import_id,
    kind: row.kind,
    leaseOwner: row.lease_owner,
    leaseUntilMs: row.lease_until,
    phase: row.phase,
    progress,
    cancellationRequestedAtMs: row.cancellation_requested_at,
    retryOfJobId: row.retry_of_job_id,
    startedAtMs: row.started_at,
    state: row.state,
    versionId: row.version_id,
  };
}

function mapUserJob(row: JobRow): UserJobRecord {
  const job = mapJob(row);
  if (!isUserJobKind(job.kind)) throw new Error("JOB_KIND_NOT_USER_INITIATED");
  return job as UserJobRecord;
}

function boundedJson(value: object): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > 65_536) {
    throw new Error("JOB_JSON_TOO_LARGE");
  }
  return json;
}

const initialProgress: JobProgress = Object.freeze({
  completed: 0,
  processed_bytes: null,
  total: null,
  unit: "steps",
});

function progressJson(value: JobProgress): string {
  if (!isJobProgress(value)) throw new Error("JOB_PROGRESS_INVALID");
  return boundedJson(value);
}

function validateSafeCode(value: string): void {
  if (!/^[A-Z][A-Z0-9_]{2,79}$/.test(value)) {
    throw new Error("JOB_ERROR_CODE_INVALID");
  }
}

function idempotencyHash(key: string): string {
  if ([...key].length < 16 || [...key].length > 200) {
    throw new Error("IDEMPOTENCY_KEY_INVALID");
  }
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function validateOperation(operation: string): void {
  if (
    operation.length < 1 ||
    operation.length > 100 ||
    !/^[a-z][a-z0-9_.:-]*$/.test(operation)
  ) {
    throw new Error("IDEMPOTENCY_OPERATION_INVALID");
  }
}

export class JobRepository {
  constructor(private readonly database: Database.Database) {}

  findByIdempotency(operation: string, key: string): UserJobRecord | null {
    validateOperation(operation);
    const row = this.database
      .prepare(
        `SELECT jobs.* FROM job_idempotency_keys
         JOIN jobs ON jobs.id = job_idempotency_keys.job_id
         WHERE operation = ? AND key_sha256 = ?`,
      )
      .get(operation, idempotencyHash(key)) as JobRow | undefined;
    return row && isUserJobKind(row.kind) ? mapUserJob(row) : null;
  }

  create(input: CreateJobInput): UserJobRecord {
    if (
      ["build_book", "purge_book"].includes(input.kind) &&
      input.bookId === undefined
    ) {
      throw new Error("JOB_BOOK_SCOPE_REQUIRED");
    }
    const nowMs = input.nowMs ?? Date.now();
    const operation = input.idempotency?.operation;
    const keySha256 = input.idempotency
      ? idempotencyHash(input.idempotency.key)
      : null;
    if (operation) validateOperation(operation);

    return this.database
      .transaction(() => {
        if (operation && keySha256) {
          const existing = this.database
            .prepare(
              `SELECT jobs.* FROM job_idempotency_keys
             JOIN jobs ON jobs.id = job_idempotency_keys.job_id
             WHERE operation = ? AND key_sha256 = ?`,
            )
            .get(operation, keySha256) as JobRow | undefined;
          if (existing) return mapUserJob(existing);
        }

        const id = createOpaqueId("job");
        const phase = input.phase ?? "queued";
        assertJobPhase(input.kind, phase);
        this.database
          .prepare(
            `INSERT INTO jobs (
            id, kind, state, import_id, book_id, version_id,
            captured_input_path, captured_source_updated_at,
            captured_current_version_id, attempt, automatic_retry_count,
            phase, progress_json, created_at
          ) VALUES (
            ?, ?, 'queued', ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?
          )`,
          )
          .run(
            id,
            input.kind,
            input.importId ?? null,
            input.bookId ?? null,
            input.versionId ?? null,
            input.capturedInputPath ?? null,
            input.capturedSourceUpdatedAt ?? null,
            input.capturedCurrentVersionId ?? null,
            phase,
            progressJson(initialProgress),
            nowMs,
          );
        if (operation && keySha256) {
          this.database
            .prepare(
              `INSERT INTO job_idempotency_keys
              (operation, key_sha256, job_id, created_at)
             VALUES (?, ?, ?, ?)`,
            )
            .run(operation, keySha256, id, nowMs);
        }
        const created = this.database
          .prepare("SELECT * FROM jobs WHERE id = ?")
          .get(id) as JobRow;
        return mapUserJob(created);
      })
      .immediate();
  }

  get(id: string): JobRecord | null {
    const row = this.database
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .get(id) as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  latestForImport(importId: string): JobRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM jobs
         WHERE import_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(importId) as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  listRecent(limit = 50): readonly JobRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("JOB_LIST_LIMIT_INVALID");
    }
    const rows = this.database
      .prepare(
        `SELECT * FROM jobs
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(limit) as JobRow[];
    return Object.freeze(rows.map(mapJob));
  }

  observeQueue(nowMs: number): QueueObservation {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new RangeError("QUEUE_OBSERVATION_TIME_INVALID");
    }
    const row = this.database
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END), 0) AS queued_count,
           COALESCE(SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END), 0) AS running_count,
           MIN(CASE WHEN state = 'queued' THEN created_at END) AS oldest_queued_at
         FROM jobs
         WHERE kind IN ('analyze_import', 'prepare_draft', 'build_book', 'purge_book')`,
      )
      .get() as {
      oldest_queued_at: number | null;
      queued_count: number;
      running_count: number;
    };
    if (row.running_count !== 0 && row.running_count !== 1) {
      throw new Error("QUEUE_RUNNING_COUNT_INVALID");
    }
    return Object.freeze({
      observedAtMs: nowMs,
      oldestQueuedAgeMs:
        row.oldest_queued_at === null
          ? null
          : Math.max(0, nowMs - row.oldest_queued_at),
      queuedCount: row.queued_count,
      runningCount: row.running_count,
    });
  }

  private getRequired(id: string): JobRecord {
    const job = this.get(id);
    if (!job) throw new Error("JOB_NOT_FOUND");
    return job;
  }

  claimNext(input: {
    readonly leaseOwner: string;
    readonly nowMs: number;
  }): UserJobRecord | null {
    return this.database
      .transaction(() => {
        if (
          this.database
            .prepare(
              `SELECT 1 FROM jobs
               WHERE state = 'running'
                 AND kind IN ('analyze_import', 'prepare_draft', 'build_book', 'purge_book')
               LIMIT 1`,
            )
            .get()
        ) {
          return null;
        }
        const candidate = this.database
          .prepare(
            `SELECT id FROM jobs
             WHERE state = 'queued'
               AND kind IN ('analyze_import', 'prepare_draft', 'build_book', 'purge_book')
               AND available_at <= ?
             ORDER BY created_at, rowid
             LIMIT 1`,
          )
          .get(input.nowMs) as { id: string } | undefined;
        if (!candidate) return null;
        const result = this.database
          .prepare(
            `UPDATE jobs
           SET state = 'running', lease_owner = ?, heartbeat_at = ?,
               lease_until = ?, started_at = ?, phase = 'starting'
           WHERE id = ? AND state = 'queued'`,
          )
          .run(
            input.leaseOwner,
            input.nowMs,
            input.nowMs + 60_000,
            input.nowMs,
            candidate.id,
          );
        if (result.changes !== 1) return null;
        const row = this.database
          .prepare("SELECT * FROM jobs WHERE id = ?")
          .get(candidate.id) as JobRow;
        return mapUserJob(row);
      })
      .immediate();
  }

  heartbeat(input: {
    readonly jobId: string;
    readonly leaseOwner: string;
    readonly nowMs: number;
    readonly phase?: string;
    readonly progress?: JobProgress;
  }): JobRecord {
    const job = this.getRequired(input.jobId);
    if (input.phase) assertJobPhase(job.kind, input.phase);
    if (input.phase || input.progress) {
      assertJobProgressUpdate({
        current: job.progress,
        currentPhase: job.phase,
        kind: job.kind,
        next: input.progress ?? job.progress,
        nextPhase: input.phase ?? job.phase,
      });
    }
    const progress = input.progress ? progressJson(input.progress) : null;
    const result = this.database
      .prepare(
        `UPDATE jobs SET heartbeat_at = ?, lease_until = ?,
           phase = COALESCE(?, phase), progress_json = COALESCE(?, progress_json)
         WHERE id = ? AND state = 'running' AND lease_owner = ?`,
      )
      .run(
        input.nowMs,
        input.nowMs + 60_000,
        input.phase ?? null,
        progress,
        input.jobId,
        input.leaseOwner,
      );
    if (result.changes !== 1) throw new Error("JOB_LEASE_NOT_OWNED");
    return this.getRequired(input.jobId);
  }

  requestCancellation(id: string, nowMs: number): JobRecord {
    return this.database
      .transaction(() => {
        const current = this.getRequired(id);
        if (isTerminalJobState(current.state)) {
          throw new Error("JOB_ALREADY_TERMINAL");
        }
        if (current.state === "queued") {
          assertJobTransition(current.state, "canceled");
          this.database
            .prepare(
              `UPDATE jobs SET state = 'canceled', cancellation_requested_at = ?,
             finished_at = ?, error_class = 'canceled',
             error_code = 'JOB_CANCELED', phase = 'canceled'
             WHERE id = ? AND state = 'queued'`,
            )
            .run(nowMs, nowMs, id);
        } else {
          this.database
            .prepare(
              `UPDATE jobs SET cancellation_requested_at = ?
             WHERE id = ? AND state = 'running'
               AND cancellation_requested_at IS NULL`,
            )
            .run(nowMs, id);
        }
        return this.getRequired(id);
      })
      .immediate();
  }

  completeSuccess(input: {
    readonly jobId: string;
    readonly leaseOwner: string;
    readonly nowMs: number;
    readonly progress?: JobProgress;
    readonly versionId?: string;
  }): JobRecord {
    const currentProgress =
      input.progress ?? this.getRequired(input.jobId).progress;
    const progress =
      currentProgress.total === null
        ? currentProgress
        : Object.freeze({
            ...currentProgress,
            completed: currentProgress.total,
          });
    return this.completeOwned({
      ...input,
      nextState: "succeeded",
      phase: "complete",
      progress,
    });
  }

  completeFailure(input: {
    readonly errorClass: JobErrorClass;
    readonly errorCode: string;
    readonly errorDetail?: Readonly<Record<string, unknown>>;
    readonly jobId: string;
    readonly leaseOwner: string;
    readonly nowMs: number;
  }): JobRecord {
    validateSafeCode(input.errorCode);
    const nextState: TerminalJobState =
      input.errorClass === "canceled" ? "canceled" : "failed";
    const current = this.getRequired(input.jobId);
    const completed = this.completeOwned({
      ...input,
      errorDetail: input.errorDetail ?? {},
      nextState,
      phase: nextState,
      progress: current.progress,
    });
    return completed;
  }

  completeInterruption(input: {
    readonly errorCode: string;
    readonly jobId: string;
    readonly leaseOwner: string;
    readonly nowMs: number;
  }): JobRecord {
    validateSafeCode(input.errorCode);
    const current = this.getRequired(input.jobId);
    return this.completeOwned({
      errorClass: "infrastructure",
      errorCode: input.errorCode,
      errorDetail: {},
      jobId: input.jobId,
      leaseOwner: input.leaseOwner,
      nextState: "interrupted",
      nowMs: input.nowMs,
      phase: "interrupted",
      progress: current.progress,
    });
  }

  private completeOwned(input: {
    readonly errorClass?: JobErrorClass;
    readonly errorCode?: string;
    readonly errorDetail?: Readonly<Record<string, unknown>>;
    readonly jobId: string;
    readonly leaseOwner: string;
    readonly nextState: TerminalJobState;
    readonly nowMs: number;
    readonly phase: string;
    readonly progress: JobProgress;
    readonly versionId?: string;
  }): JobRecord {
    return this.database
      .transaction(() => {
        const current = this.getRequired(input.jobId);
        assertJobTransition(current.state, input.nextState);
        assertJobPhase(current.kind, input.phase);
        const result = this.database
          .prepare(
            `UPDATE jobs SET state = ?, phase = ?, progress_json = ?,
               error_class = ?, error_code = ?, error_detail_json = ?,
               version_id = COALESCE(?, version_id), finished_at = ?,
               lease_owner = NULL, lease_until = NULL
             WHERE id = ? AND state = 'running' AND lease_owner = ?`,
          )
          .run(
            input.nextState,
            input.phase,
            progressJson(input.progress),
            input.errorClass ?? null,
            input.errorCode ?? null,
            input.errorDetail ? boundedJson(input.errorDetail) : null,
            input.versionId ?? null,
            input.nowMs,
            input.jobId,
            input.leaseOwner,
          );
        if (result.changes !== 1) throw new Error("JOB_LEASE_NOT_OWNED");
        return this.getRequired(input.jobId);
      })
      .immediate();
  }

  interruptExpired(input: {
    readonly nowMs: number;
    readonly onInterrupted?: (job: UserJobRecord) => void;
  }): readonly UserJobRecord[] {
    return this.database
      .transaction(() => {
        const rows = this.database
          .prepare(
            `SELECT id FROM jobs
             WHERE state = 'running' AND lease_until < ?
               AND kind IN ('analyze_import', 'prepare_draft', 'build_book', 'purge_book')
             ORDER BY id`,
          )
          .all(input.nowMs) as { id: string }[];
        const update = this.database.prepare(
          `UPDATE jobs SET state = 'interrupted', phase = 'interrupted',
           error_class = 'infrastructure', error_code = 'JOB_LEASE_EXPIRED',
           finished_at = ?, lease_owner = NULL, lease_until = NULL
           WHERE id = ? AND state = 'running' AND lease_until < ?
             AND kind IN ('analyze_import', 'prepare_draft', 'build_book', 'purge_book')`,
        );
        const interrupted: UserJobRecord[] = [];
        for (const row of rows) {
          if (update.run(input.nowMs, row.id, input.nowMs).changes === 1) {
            const stored = this.database
              .prepare("SELECT * FROM jobs WHERE id = ?")
              .get(row.id) as JobRow;
            const job = mapUserJob(stored);
            input.onInterrupted?.(job);
            interrupted.push(job);
          }
        }
        return interrupted;
      })
      .immediate();
  }

  listPendingAutomaticRetries(): readonly UserJobRecord[] {
    const rows = this.database
      .prepare(
        `SELECT jobs.* FROM jobs
         WHERE jobs.state = 'interrupted'
           AND jobs.kind IN ('analyze_import', 'prepare_draft', 'build_book', 'purge_book')
           AND jobs.error_class = 'infrastructure'
           AND jobs.error_code IN ('JOB_LEASE_EXPIRED', 'WORKER_SHUTDOWN')
           AND jobs.automatic_retry_count = 0
           AND jobs.cancellation_requested_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM jobs AS retry
             WHERE retry.retry_of_job_id = jobs.id
           )
         ORDER BY jobs.finished_at, jobs.id`,
      )
      .all() as JobRow[];
    return Object.freeze(rows.map(mapUserJob));
  }

  fail(
    id: string,
    input: {
      readonly errorClass: JobErrorClass;
      readonly errorCode: string;
      readonly nowMs: number;
    },
  ): JobRecord {
    validateSafeCode(input.errorCode);
    const current = this.getRequired(id);
    if (current.state === "queued") {
      return this.database
        .transaction(() => {
          const result = this.database
            .prepare(
              `UPDATE jobs SET state = 'failed', phase = 'failed',
               error_class = ?, error_code = ?, finished_at = ?
               WHERE id = ? AND state = 'queued'`,
            )
            .run(input.errorClass, input.errorCode, input.nowMs, id);
          if (result.changes !== 1) throw new Error("JOB_TRANSITION_RACE");
          return this.getRequired(id);
        })
        .immediate();
    }
    if (!current.leaseOwner) throw new Error("JOB_LEASE_NOT_OWNED");
    return this.completeFailure({
      ...input,
      jobId: id,
      leaseOwner: current.leaseOwner,
    });
  }

  latestRetryOf(jobId: string): UserJobRecord | null {
    const row = this.database
      .prepare(
        "SELECT * FROM jobs WHERE retry_of_job_id=? ORDER BY created_at DESC,id DESC LIMIT 1",
      )
      .get(jobId) as JobRow | undefined;
    return row ? mapUserJob(row) : null;
  }

  retry(
    id: string,
    input: {
      readonly automatic: boolean;
      readonly idempotency?: {
        readonly key: string;
        readonly operation: string;
      };
      readonly nowMs: number;
      readonly nextAttempt?: {
        readonly capturedCurrentVersionId: string | null;
        readonly versionId: string;
      };
    },
  ): UserJobRecord {
    return this.database
      .transaction(() => {
        const original = this.getRequired(id);
        if (
          original.state === "succeeded" ||
          !isTerminalJobState(original.state) ||
          !isUserJobKind(original.kind)
        ) {
          throw new Error("JOB_NOT_RETRYABLE");
        }
        if (original.errorCode === "JOB_SUBJECT_DELETED") {
          throw new Error("JOB_SUBJECT_DELETED");
        }
        const automaticRetryCount =
          original.automaticRetryCount + (input.automatic ? 1 : 0);
        if (automaticRetryCount > 1) {
          throw new Error("AUTOMATIC_RETRY_LIMIT_EXCEEDED");
        }

        const operation = input.idempotency?.operation;
        const keySha256 = input.idempotency
          ? idempotencyHash(input.idempotency.key)
          : null;
        if (operation) validateOperation(operation);
        if (operation && keySha256) {
          const existing = this.database
            .prepare(
              `SELECT jobs.* FROM job_idempotency_keys
             JOIN jobs ON jobs.id = job_idempotency_keys.job_id
             WHERE operation = ? AND key_sha256 = ?`,
            )
            .get(operation, keySha256) as JobRow | undefined;
          if (existing) return mapUserJob(existing);
        }

        const retryId = createOpaqueId("job");
        if (original.kind === "build_book" && !input.nextAttempt) {
          throw new Error("BUILD_RETRY_REQUIRES_OWNER");
        }
        if (original.kind !== "build_book" && input.nextAttempt) {
          throw new Error("JOB_RETRY_CAPTURE_FORBIDDEN");
        }
        this.database
          .prepare(
            `INSERT INTO jobs (
              id, kind, state, import_id, book_id, version_id,
              captured_input_path, captured_source_updated_at,
              captured_current_version_id, retry_of_job_id, attempt,
              automatic_retry_count, phase, progress_json, created_at
            ) VALUES (
              ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?
            )`,
          )
          .run(
            retryId,
            original.kind,
            original.importId,
            original.bookId,
            input.nextAttempt
              ? input.nextAttempt.versionId
              : original.versionId,
            original.capturedInputPath,
            original.capturedSourceUpdatedAt,
            input.nextAttempt
              ? input.nextAttempt.capturedCurrentVersionId
              : original.capturedCurrentVersionId,
            original.id,
            original.attempt + 1,
            automaticRetryCount,
            progressJson(initialProgress),
            input.nowMs,
          );
        if (operation && keySha256) {
          this.database
            .prepare(
              `INSERT INTO job_idempotency_keys
              (operation, key_sha256, job_id, created_at)
             VALUES (?, ?, ?, ?)`,
            )
            .run(operation, keySha256, retryId, input.nowMs);
        }
        const retry = this.database
          .prepare("SELECT * FROM jobs WHERE id = ?")
          .get(retryId) as JobRow;
        return mapUserJob(retry);
      })
      .immediate();
  }
}
