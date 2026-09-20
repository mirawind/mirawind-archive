import { resolve } from "node:path";

import type { WorkerStorageHealth } from "@/entrypoints/worker/checkpoint";
import type { QueueObservation } from "@/modules/publishing/application/publishing-api";
import type { AttemptObservation } from "@/observability/attempt-observation";
import { createLogger } from "@/observability/logger";
import {
  WorkerHealthFileReporter,
  workerHealthCoalesceMs,
  workerHealthSchemaVersion,
  type WorkerHealthSnapshot,
} from "@/observability/worker-health";
import type { StorageLayout } from "@/platform/filesystem/storage-layout";

const activeRefreshMs = 5_000;
const idleRefreshMs = 60_000;
const logger = createLogger({ service: "worker" });

function queueKey(value: QueueObservation): string {
  return `${value.queuedCount}:${value.runningCount}:${value.oldestQueuedAgeMs === null ? "none" : "waiting"}`;
}

export class WorkerHealthReporter {
  private attempt: AttemptObservation | null = null;
  private checkpoint: WorkerStorageHealth | null = null;
  private lastAttemptRefreshAtMs: number | null = null;
  private lastQueueKey: string | null = null;
  private lastQueueRefreshAtMs: number | null = null;
  private pending: Promise<void> = Promise.resolve();
  private queue: QueueObservation | null = null;
  private recentAttempt: AttemptObservation | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly writer: WorkerHealthFileReporter;

  constructor(layout: StorageLayout) {
    this.writer = new WorkerHealthFileReporter(
      resolve(layout.temporaryDirectory, "worker-health.json"),
    );
  }

  recordCheckpoint(value: WorkerStorageHealth, nowMs: number): void {
    this.checkpoint = value;
    this.schedule(nowMs);
  }

  recordQueue(value: QueueObservation, nowMs = Date.now()): void {
    const key = queueKey(value);
    const changed = key !== this.lastQueueKey;
    const due =
      this.lastQueueRefreshAtMs === null ||
      nowMs - this.lastQueueRefreshAtMs >= idleRefreshMs;
    this.queue = value;
    if (changed || due) {
      this.lastQueueKey = key;
      this.lastQueueRefreshAtMs = nowMs;
      this.schedule(nowMs);
    }
  }

  recordAttempt(value: AttemptObservation, nowMs = Date.now()): void {
    const previousPhase = this.attempt?.stages.at(-1)?.phase ?? null;
    const nextPhase = value.stages.at(-1)?.phase ?? null;
    if (value.state === "running") this.attempt = value;
    else {
      this.attempt = null;
      this.recentAttempt = value;
    }
    const due =
      this.lastAttemptRefreshAtMs === null ||
      nowMs - this.lastAttemptRefreshAtMs >= activeRefreshMs;
    if (value.state !== "running" || previousPhase !== nextPhase || due) {
      this.lastAttemptRefreshAtMs = nowMs;
      this.schedule(nowMs);
    }
  }

  async drain(): Promise<void> {
    await this.pending;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      await new Promise((resolve) =>
        setTimeout(resolve, workerHealthCoalesceMs),
      );
      this.schedule(Date.now());
      await this.pending;
    }
  }

  private snapshot(nowMs: number): WorkerHealthSnapshot | null {
    if (!this.checkpoint || !this.queue) return null;
    return Object.freeze({
      checkedAt: new Date(nowMs).toISOString(),
      checkpoint: this.checkpoint.checkpoint,
      currentAttempt: this.attempt,
      lease: this.checkpoint.lease,
      queue: this.queue,
      recentAttempt: this.recentAttempt,
      schemaVersion: workerHealthSchemaVersion,
      status: this.checkpoint.status,
      walBytes: this.checkpoint.walBytes,
      warnings: this.checkpoint.warnings,
    });
  }

  private schedule(nowMs: number): void {
    const snapshot = this.snapshot(nowMs);
    if (!snapshot) return;
    this.pending = this.pending
      .then(async () => {
        const result = await this.writer.writeIfDue(snapshot, nowMs);
        if (result === "written") {
          logger.info({
            event: "worker.health.updated",
            queuedCount: snapshot.queue.queuedCount,
            runningCount: snapshot.queue.runningCount,
            state:
              snapshot.currentAttempt?.state ??
              snapshot.recentAttempt?.state ??
              "idle",
          });
        } else if (result === "unavailable") {
          logger.warn({ event: "worker.health.unavailable" });
        } else if (result === "deferred" && !this.retryTimer) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.schedule(Date.now());
          }, workerHealthCoalesceMs);
          this.retryTimer.unref();
        }
      })
      .catch(() => undefined);
  }
}
