import type Database from "better-sqlite3";

import { markBookDeletionPurging } from "../book-deletion";
import { captureFrozenJobInput } from "./capture-frozen-input";
import { BuildRepository } from "@/modules/publishing/adapters/sqlite/builds";
import { DraftRepository } from "@/modules/publishing/adapters/sqlite/drafts";
import { ImportRepository } from "@/modules/publishing/adapters/sqlite/imports";
import {
  JobRepository,
  type UserJobRecord,
} from "@/modules/publishing/adapters/sqlite/jobs";
import {
  isJobPhase,
  type JobPhase,
  type JobProgress,
} from "@/modules/publishing/application/publishing-api";
import {
  runJobChild,
  type ChildExecution,
} from "@/entrypoints/worker/child-runner";
import type { ProcessTreeMemoryObservation } from "@/observability/attempt-observation";
import type { StorageLayout } from "@/platform/filesystem/storage-layout";
import { withImmediateTransaction } from "@/platform/sqlite/immediate-transaction";
import type { FrozenJobInput } from "@/entrypoints/worker/protocol";
import { SafeApplicationError } from "@/domain/errors";

export const workerHeartbeatIntervalMs = 10_000;

const unavailableMemory: ProcessTreeMemoryObservation = Object.freeze({
  failedSamples: 0,
  peakProcessTreeRssBytes: null,
  sampleIntervalMs: 250,
  samples: 0,
  status: "unavailable",
});

export type WorkerAttemptExecutionOutcome =
  | Readonly<{
      command: FrozenJobInput;
      execution: ChildExecution;
      kind: "child_closed";
      shutdownRequested: boolean;
    }>
  | Readonly<{
      errorCode: string;
      kind: "execution_failed";
      memory: ProcessTreeMemoryObservation;
    }>;

function safeExecutionError(error: unknown): string {
  if (error instanceof SafeApplicationError) return error.code;
  return error instanceof Error && /^[A-Z][A-Z0-9_]{2,79}$/u.test(error.message)
    ? error.message
    : "WORKER_JOB_EXECUTION_FAILED";
}

export async function executeWorkerAttempt(input: {
  readonly builds: BuildRepository;
  readonly childRunner?: typeof runJobChild;
  readonly database: Database.Database;
  readonly job: UserJobRecord;
  readonly drafts: DraftRepository;
  readonly imports: ImportRepository;
  readonly leaseOwner: string;
  readonly repository: JobRepository;
  readonly shutdownSignal: AbortSignal;
  readonly layout: StorageLayout;
  readonly onProgress?: (progress: {
    readonly phase: JobPhase;
    readonly progress: JobProgress;
  }) => void;
}): Promise<WorkerAttemptExecutionOutcome> {
  const childController = new AbortController();
  const onShutdown = () => childController.abort("worker-shutdown");
  input.shutdownSignal.addEventListener("abort", onShutdown, { once: true });
  const heartbeat = setInterval(() => {
    try {
      const current = input.repository.heartbeat({
        jobId: input.job.id,
        leaseOwner: input.leaseOwner,
        nowMs: Date.now(),
      });
      if (current.cancellationRequestedAtMs !== null) {
        childController.abort("cancellation-requested");
      }
    } catch {
      childController.abort("lease-lost");
    }
  }, workerHeartbeatIntervalMs);

  try {
    if (input.job.kind === "purge_book") {
      markBookDeletionPurging(input.database, input.job.id, Date.now());
    }
    if (input.job.kind === "analyze_import" && input.job.importId) {
      input.imports.startAnalysis(input.job.importId, Date.now());
    }
    if (input.job.kind === "prepare_draft" && input.job.importId) {
      const imported = input.imports.require(input.job.importId);
      if (imported.bookId === null) {
        withImmediateTransaction(input.database, () => {
          const nowMs = Date.now();
          const book = input.drafts.createBook({
            nowMs,
            title: "Pending import",
          });
          input.imports.attachBookForPreparation({
            bookId: book.id,
            importId: imported.id,
            nowMs,
          });
        });
      }
    }
    const command = await captureFrozenJobInput({
      job: input.job,
      builds: input.builds,
      imports: input.imports,
      database: input.database,
      layout: input.layout,
    });
    const execution = await (input.childRunner ?? runJobChild)(command, {
      onProgress(progress) {
        try {
          if (!isJobPhase(input.job.kind, progress.phase)) {
            throw new Error("JOB_PHASE_INVALID");
          }
          input.repository.heartbeat({
            jobId: input.job.id,
            leaseOwner: input.leaseOwner,
            nowMs: Date.now(),
            phase: progress.phase,
            progress: progress.progress,
          });
          input.onProgress?.(progress);
        } catch {
          childController.abort("progress-lease-lost");
        }
      },
      signal: childController.signal,
      storageRoot: input.layout.root,
    });
    return Object.freeze({
      command,
      execution,
      kind: "child_closed",
      shutdownRequested: input.shutdownSignal.aborted,
    });
  } catch (error) {
    return Object.freeze({
      errorCode: safeExecutionError(error),
      kind: "execution_failed",
      memory: unavailableMemory,
    });
  } finally {
    clearInterval(heartbeat);
    input.shutdownSignal.removeEventListener("abort", onShutdown);
  }
}
