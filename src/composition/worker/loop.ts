import type Database from "better-sqlite3";
import { setTimeout as wait } from "node:timers/promises";

import { executeWorkerAttempt } from "./execute-attempt";
import { completeWorkerAttempt } from "./complete-attempt";
import { recoverWorkerAttempts } from "./recover-attempts";
import { BuildRepository } from "@/modules/publishing/adapters/sqlite/builds";
import { DraftRepository } from "@/modules/publishing/adapters/sqlite/drafts";
import { ImportRepository } from "@/modules/publishing/adapters/sqlite/imports";
import { JobRepository } from "@/modules/publishing/adapters/sqlite/jobs";
import type {
  JobPhase,
  JobProgress,
  QueueObservation,
  TerminalJobState,
} from "@/modules/publishing/application/publishing-api";
import {
  WorkerCheckpointScheduler,
  type WorkerStorageHealth,
} from "@/entrypoints/worker/checkpoint";
import {
  AttemptObservationTracker,
  type AttemptObservation,
} from "@/observability/attempt-observation";
import { operationalMetrics } from "@/observability/metrics";
import type { StorageLayout } from "@/platform/filesystem/storage-layout";

export const workerPollIntervalMs = 1_000;

function terminalState(state: string): state is TerminalJobState {
  return ["succeeded", "failed", "canceled", "interrupted"].includes(state);
}

export async function runWorkerLoop(input: {
  readonly builds: BuildRepository;
  readonly database: Database.Database;
  readonly drafts: DraftRepository;
  readonly imports: ImportRepository;
  readonly layout: StorageLayout;
  readonly onIdle?: () => Promise<void>;
  readonly onMaintenance?: () => Promise<void>;
  readonly onAttemptObservation?: (observation: AttemptObservation) => void;
  readonly onCheckpoint?: (health: WorkerStorageHealth, nowMs: number) => void;
  readonly onQueueObservation?: (observation: QueueObservation) => void;
  readonly repository: JobRepository;
  readonly scheduler: WorkerCheckpointScheduler;
  readonly shutdownSignal: AbortSignal;
  readonly workerId: string;
}): Promise<void> {
  let nextIdleMaintenanceAt = 0;
  let nextMaintenanceAt = 0;
  while (!input.shutdownSignal.aborted) {
    const loopNowMs = Date.now();
    await recoverWorkerAttempts({
      builds: input.builds,
      database: input.database,
      nowMs: loopNowMs,
      repository: input.repository,
      storageRoot: input.layout.root,
    });
    const checkpoint = await input.scheduler.checkpointIfDue(loopNowMs);
    if (checkpoint) input.onCheckpoint?.(checkpoint, loopNowMs);
    if (input.onMaintenance && loopNowMs >= nextMaintenanceAt) {
      await input.onMaintenance();
      nextMaintenanceAt = Date.now() + 60_000;
      if (input.shutdownSignal.aborted) break;
    }
    input.onQueueObservation?.(input.repository.observeQueue(loopNowMs));
    const job = input.repository.claimNext({
      leaseOwner: input.workerId,
      nowMs: loopNowMs,
    });
    if (!job) {
      if (input.onIdle && loopNowMs >= nextIdleMaintenanceAt) {
        nextIdleMaintenanceAt = loopNowMs + 60_000;
        await input.onIdle();
        continue;
      }
      await wait(workerPollIntervalMs, undefined, {
        signal: input.shutdownSignal,
      }).catch((error) => {
        if (error.name !== "AbortError") throw error;
      });
      continue;
    }
    input.onQueueObservation?.(input.repository.observeQueue(loopNowMs));
    operationalMetrics.recordQueueAge(Math.max(0, loopNowMs - job.createdAtMs));
    const tracker = new AttemptObservationTracker({
      attempt: job.attempt,
      jobId: job.id,
      kind: job.kind,
      startedAtMs: job.startedAtMs ?? loopNowMs,
    });
    const startedAtMs = Date.now();
    const outcome = await executeWorkerAttempt({
      builds: input.builds,
      job,
      database: input.database,
      drafts: input.drafts,
      imports: input.imports,
      leaseOwner: input.workerId,
      onProgress(progress: {
        readonly phase: JobPhase;
        readonly progress: JobProgress;
      }) {
        tracker.recordProgress(progress);
        input.onAttemptObservation?.(tracker.snapshot());
      },
      repository: input.repository,
      shutdownSignal: input.shutdownSignal,
      layout: input.layout,
    });
    const memory = await completeWorkerAttempt({
      builds: input.builds,
      database: input.database,
      imports: input.imports,
      job,
      layout: input.layout,
      leaseOwner: input.workerId,
      outcome,
      repository: input.repository,
    });
    operationalMetrics.recordPhase(job.kind, Date.now() - startedAtMs);
    const completed = input.repository.get(job.id);
    if (completed?.errorClass && completed.errorCode) {
      operationalMetrics.recordFailure(
        completed.errorClass,
        completed.errorCode,
      );
    }
    if (completed) {
      operationalMetrics.recordTransition(
        `job.${completed.kind}.${completed.state}`,
      );
      if (terminalState(completed.state) && completed.finishedAtMs !== null) {
        input.onAttemptObservation?.(
          tracker.complete({
            errorClass: completed.errorClass,
            errorCode: completed.errorCode,
            finishedAtMs: completed.finishedAtMs,
            memory,
            state: completed.state,
          }),
        );
      }
    }
    input.onQueueObservation?.(input.repository.observeQueue(Date.now()));
  }
}
