import type Database from "better-sqlite3";

import {
  recordExpiredJobLifecycle,
  retryJobAttempt,
} from "./attempt-lifecycle";
import { BuildRepository } from "@/modules/publishing/adapters/sqlite/builds";
import {
  JobRepository,
  type UserJobRecord,
} from "@/modules/publishing/adapters/sqlite/jobs";
import { recoverExpiredJobLeases } from "@/modules/publishing/application/recover-expired-jobs";
import { operationalMetrics } from "@/observability/metrics";

export async function recoverWorkerAttempts(input: {
  readonly builds: BuildRepository;
  readonly database: Database.Database;
  readonly nowMs: number;
  readonly repository: JobRepository;
  readonly storageRoot: string;
}): Promise<void> {
  const recovered = await recoverExpiredJobLeases({
    nowMs: input.nowMs,
    onInterrupted: (job) =>
      recordExpiredJobLifecycle({
        builds: input.builds,
        database: input.database,
        job,
        nowMs: input.nowMs,
      }),
    repository: input.repository,
    retryJob: (job, nowMs) =>
      retryJobAttempt({
        automatic: true,
        builds: input.builds,
        database: input.database,
        job,
        jobs: input.repository,
        nowMs,
      }) as UserJobRecord,
    storageRoot: input.storageRoot,
  });
  for (const item of recovered) {
    operationalMetrics.recordTransition(
      item.retry ? "recovery.auto_retry" : "recovery.interrupted",
    );
  }
}
