import { readFile, stat } from "node:fs/promises";

import { isOpaqueId } from "@/domain/ids";
import {
  isJobPhase,
  isJobProgress,
  isJobErrorClass,
  jobKinds,
  type JobKind,
  type QueueObservation,
  type TerminalJobState,
} from "@/modules/publishing/application/publishing-api";
import type {
  AttemptObservation,
  ProcessTreeMemoryObservation,
  StageObservation,
} from "./attempt-observation";
import { atomicWriteFile } from "@/platform/filesystem/atomic-file";

export const maximumWorkerHealthBytes = 64 * 1_024;
export const workerHealthSchemaVersion = 3 as const;
export const workerHealthCoalesceMs = 1_000;

export interface WorkerHealthSnapshot {
  readonly checkedAt: string;
  readonly checkpoint: {
    readonly busy: number;
    readonly checkpointedPages: number;
    readonly logPages: number;
    readonly mode: "PASSIVE";
  };
  readonly currentAttempt: AttemptObservation | null;
  readonly lease: {
    readonly activeJobs: number;
    readonly earliestExpiry: string | null;
  };
  readonly queue: QueueObservation;
  readonly recentAttempt: AttemptObservation | null;
  readonly schemaVersion: typeof workerHealthSchemaVersion;
  readonly status: "healthy" | "warning";
  readonly walBytes: number;
  readonly warnings: readonly string[];
}

type HealthWriteResult = "deferred" | "unavailable" | "unchanged" | "written";

interface WorkerHealthWriter {
  write(
    path: string,
    value: string,
    options: Readonly<{ mode: number }>,
  ): Promise<void>;
}

function record(
  value: unknown,
  code: string,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(code);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exact(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  code: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(code);
  }
}

function integer(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(code);
  }
  return value;
}

function nonnegativeNumber(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(code);
  }
  return value;
}

function timestamp(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(code);
  }
  return value;
}

function safeCode(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{2,79}$/u.test(value)) {
    throw new Error(code);
  }
  return value;
}

function parseQueue(value: unknown): QueueObservation {
  const item = record(value, "WORKER_HEALTH_QUEUE_INVALID");
  exact(
    item,
    ["observedAtMs", "oldestQueuedAgeMs", "queuedCount", "runningCount"],
    "WORKER_HEALTH_QUEUE_FIELDS_INVALID",
  );
  const runningCount = integer(
    item.runningCount,
    "WORKER_HEALTH_QUEUE_RUNNING_INVALID",
  );
  if (runningCount !== 0 && runningCount !== 1) {
    throw new Error("WORKER_HEALTH_QUEUE_RUNNING_INVALID");
  }
  return Object.freeze({
    observedAtMs: integer(
      item.observedAtMs,
      "WORKER_HEALTH_QUEUE_TIME_INVALID",
    ),
    oldestQueuedAgeMs:
      item.oldestQueuedAgeMs === null
        ? null
        : integer(item.oldestQueuedAgeMs, "WORKER_HEALTH_QUEUE_AGE_INVALID"),
    queuedCount: integer(item.queuedCount, "WORKER_HEALTH_QUEUE_COUNT_INVALID"),
    runningCount,
  });
}

function parseMemory(value: unknown): ProcessTreeMemoryObservation {
  const item = record(value, "WORKER_HEALTH_MEMORY_INVALID");
  exact(
    item,
    [
      "failedSamples",
      "peakProcessTreeRssBytes",
      "sampleIntervalMs",
      "samples",
      "status",
    ],
    "WORKER_HEALTH_MEMORY_FIELDS_INVALID",
  );
  const samples = integer(item.samples, "WORKER_HEALTH_MEMORY_SAMPLES_INVALID");
  const peak =
    item.peakProcessTreeRssBytes === null
      ? null
      : integer(
          item.peakProcessTreeRssBytes,
          "WORKER_HEALTH_MEMORY_PEAK_INVALID",
        );
  if (
    (item.status !== "available" && item.status !== "unavailable") ||
    (item.status === "available") !== (peak !== null && samples > 0)
  ) {
    throw new Error("WORKER_HEALTH_MEMORY_STATUS_INVALID");
  }
  const interval = integer(
    item.sampleIntervalMs,
    "WORKER_HEALTH_MEMORY_INTERVAL_INVALID",
  );
  if (interval < 1) throw new Error("WORKER_HEALTH_MEMORY_INTERVAL_INVALID");
  return Object.freeze({
    failedSamples: integer(
      item.failedSamples,
      "WORKER_HEALTH_MEMORY_FAILURES_INVALID",
    ),
    peakProcessTreeRssBytes: peak,
    sampleIntervalMs: interval,
    samples,
    status: item.status,
  });
}

function parseStage(value: unknown, kind: JobKind): StageObservation {
  const item = record(value, "WORKER_HEALTH_STAGE_INVALID");
  exact(
    item,
    ["durationMs", "phase", "progress", "startedAtMs", "status"],
    "WORKER_HEALTH_STAGE_FIELDS_INVALID",
  );
  if (typeof item.phase !== "string" || !isJobPhase(kind, item.phase)) {
    throw new Error("WORKER_HEALTH_STAGE_PHASE_INVALID");
  }
  if (!isJobProgress(item.progress)) {
    throw new Error("WORKER_HEALTH_STAGE_PROGRESS_INVALID");
  }
  if (
    ![
      "running",
      "completed",
      "succeeded",
      "failed",
      "canceled",
      "interrupted",
    ].includes(String(item.status))
  ) {
    throw new Error("WORKER_HEALTH_STAGE_STATUS_INVALID");
  }
  return Object.freeze({
    durationMs: nonnegativeNumber(
      item.durationMs,
      "WORKER_HEALTH_STAGE_DURATION_INVALID",
    ),
    phase: item.phase,
    progress: Object.freeze({ ...item.progress }),
    startedAtMs: integer(item.startedAtMs, "WORKER_HEALTH_STAGE_START_INVALID"),
    status: item.status as StageObservation["status"],
  });
}

function parseAttempt(value: unknown): AttemptObservation {
  const item = record(value, "WORKER_HEALTH_ATTEMPT_INVALID");
  exact(
    item,
    [
      "attempt",
      "durationMs",
      "errorClass",
      "errorCode",
      "finishedAtMs",
      "jobId",
      "kind",
      "memory",
      "stages",
      "startedAtMs",
      "state",
    ],
    "WORKER_HEALTH_ATTEMPT_FIELDS_INVALID",
  );
  if (
    typeof item.jobId !== "string" ||
    !isOpaqueId("job", item.jobId) ||
    !jobKinds.includes(item.kind as JobKind) ||
    !Array.isArray(item.stages) ||
    item.stages.length < 1 ||
    item.stages.length > 20
  ) {
    throw new Error("WORKER_HEALTH_ATTEMPT_IDENTITY_INVALID");
  }
  const kind = item.kind as JobKind;
  const state = item.state;
  if (
    !["running", "succeeded", "failed", "canceled", "interrupted"].includes(
      String(state),
    )
  ) {
    throw new Error("WORKER_HEALTH_ATTEMPT_STATE_INVALID");
  }
  const errorClass = item.errorClass;
  if (errorClass !== null && !isJobErrorClass(errorClass)) {
    throw new Error("WORKER_HEALTH_ATTEMPT_ERROR_CLASS_INVALID");
  }
  const errorCode =
    item.errorCode === null
      ? null
      : safeCode(item.errorCode, "WORKER_HEALTH_ATTEMPT_ERROR_CODE_INVALID");
  const finishedAtMs =
    item.finishedAtMs === null
      ? null
      : integer(item.finishedAtMs, "WORKER_HEALTH_ATTEMPT_FINISH_INVALID");
  if (
    (state === "running" &&
      (finishedAtMs !== null || errorClass !== null || errorCode !== null)) ||
    (state !== "running" && finishedAtMs === null)
  ) {
    throw new Error("WORKER_HEALTH_ATTEMPT_TERMINAL_INVALID");
  }
  const attempt = integer(item.attempt, "WORKER_HEALTH_ATTEMPT_NUMBER_INVALID");
  if (attempt < 1) throw new Error("WORKER_HEALTH_ATTEMPT_NUMBER_INVALID");
  return Object.freeze({
    attempt,
    durationMs: nonnegativeNumber(
      item.durationMs,
      "WORKER_HEALTH_ATTEMPT_DURATION_INVALID",
    ),
    errorClass,
    errorCode,
    finishedAtMs,
    jobId: item.jobId,
    kind,
    memory: parseMemory(item.memory),
    stages: Object.freeze(item.stages.map((stage) => parseStage(stage, kind))),
    startedAtMs: integer(
      item.startedAtMs,
      "WORKER_HEALTH_ATTEMPT_START_INVALID",
    ),
    state: state as "running" | TerminalJobState,
  });
}

export function parseWorkerHealthSnapshot(
  value: unknown,
): WorkerHealthSnapshot {
  const item = record(value, "WORKER_HEALTH_INVALID");
  exact(
    item,
    [
      "checkedAt",
      "checkpoint",
      "currentAttempt",
      "lease",
      "queue",
      "recentAttempt",
      "schemaVersion",
      "status",
      "walBytes",
      "warnings",
    ],
    "WORKER_HEALTH_FIELDS_INVALID",
  );
  if (item.schemaVersion !== workerHealthSchemaVersion) {
    throw new Error("WORKER_HEALTH_SCHEMA_UNSUPPORTED");
  }
  const checkpoint = record(
    item.checkpoint,
    "WORKER_HEALTH_CHECKPOINT_INVALID",
  );
  exact(
    checkpoint,
    ["busy", "checkpointedPages", "logPages", "mode"],
    "WORKER_HEALTH_CHECKPOINT_FIELDS_INVALID",
  );
  if (checkpoint.mode !== "PASSIVE") {
    throw new Error("WORKER_HEALTH_CHECKPOINT_MODE_INVALID");
  }
  const lease = record(item.lease, "WORKER_HEALTH_LEASE_INVALID");
  exact(
    lease,
    ["activeJobs", "earliestExpiry"],
    "WORKER_HEALTH_LEASE_FIELDS_INVALID",
  );
  const activeJobs = integer(
    lease.activeJobs,
    "WORKER_HEALTH_LEASE_COUNT_INVALID",
  );
  if (activeJobs > 1) throw new Error("WORKER_HEALTH_LEASE_COUNT_INVALID");
  if (item.status !== "healthy" && item.status !== "warning") {
    throw new Error("WORKER_HEALTH_STATUS_INVALID");
  }
  if (!Array.isArray(item.warnings) || item.warnings.length > 20) {
    throw new Error("WORKER_HEALTH_WARNINGS_INVALID");
  }
  return Object.freeze({
    checkedAt: timestamp(item.checkedAt, "WORKER_HEALTH_TIME_INVALID"),
    checkpoint: Object.freeze({
      busy: integer(checkpoint.busy, "WORKER_HEALTH_CHECKPOINT_BUSY_INVALID"),
      checkpointedPages: integer(
        checkpoint.checkpointedPages,
        "WORKER_HEALTH_CHECKPOINT_PAGES_INVALID",
      ),
      logPages: integer(
        checkpoint.logPages,
        "WORKER_HEALTH_CHECKPOINT_LOG_INVALID",
      ),
      mode: "PASSIVE",
    }),
    currentAttempt:
      item.currentAttempt === null ? null : parseAttempt(item.currentAttempt),
    lease: Object.freeze({
      activeJobs,
      earliestExpiry:
        lease.earliestExpiry === null
          ? null
          : timestamp(
              lease.earliestExpiry,
              "WORKER_HEALTH_LEASE_EXPIRY_INVALID",
            ),
    }),
    queue: parseQueue(item.queue),
    recentAttempt:
      item.recentAttempt === null ? null : parseAttempt(item.recentAttempt),
    schemaVersion: workerHealthSchemaVersion,
    status: item.status,
    walBytes: integer(item.walBytes, "WORKER_HEALTH_WAL_INVALID"),
    warnings: Object.freeze(
      item.warnings.map((warning) =>
        safeCode(warning, "WORKER_HEALTH_WARNING_INVALID"),
      ),
    ),
  });
}

export async function readWorkerHealthSnapshot(
  path: string,
): Promise<WorkerHealthSnapshot | null> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > maximumWorkerHealthBytes)
      return null;
    return parseWorkerHealthSnapshot(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );
  } catch {
    return null;
  }
}

export class WorkerHealthFileReporter {
  private lastJson: string | null = null;
  private lastWrittenAtMs: number | null = null;
  private readonly writer: WorkerHealthWriter;

  constructor(
    private readonly path: string,
    options: Readonly<Partial<WorkerHealthWriter>> = {},
  ) {
    this.writer = {
      write:
        options.write ??
        ((target, value, writeOptions) =>
          atomicWriteFile(target, value, { mode: writeOptions.mode })),
    };
  }

  async writeIfDue(
    snapshot: WorkerHealthSnapshot,
    nowMs: number,
  ): Promise<HealthWriteResult> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new RangeError("WORKER_HEALTH_WRITE_TIME_INVALID");
    }
    let json: string;
    try {
      json = `${JSON.stringify(parseWorkerHealthSnapshot(snapshot))}\n`;
      if (Buffer.byteLength(json, "utf8") > maximumWorkerHealthBytes) {
        return "unavailable";
      }
    } catch {
      return "unavailable";
    }
    if (json === this.lastJson) return "unchanged";
    if (
      this.lastWrittenAtMs !== null &&
      nowMs - this.lastWrittenAtMs < workerHealthCoalesceMs
    ) {
      return "deferred";
    }
    try {
      await this.writer.write(this.path, json, { mode: 0o600 });
    } catch {
      return "unavailable";
    }
    this.lastJson = json;
    this.lastWrittenAtMs = nowMs;
    return "written";
  }
}
