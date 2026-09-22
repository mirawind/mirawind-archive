import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { recoverWorkerAttempts } from "./recover-attempts";
import { WorkerHealthReporter } from "./health-reporter";
import { runWorkerLoop } from "./loop";
import { runWorkerMaintenance, runIdleReconciliation } from "./maintenance";
import { parseEnvironment } from "@/config/environment";
import { BuildRepository } from "@/modules/publishing/adapters/sqlite/builds";
import { DraftRepository } from "@/modules/publishing/adapters/sqlite/drafts";
import { ImportRepository } from "@/modules/publishing/adapters/sqlite/imports";
import { JobRepository } from "@/modules/publishing/adapters/sqlite/jobs";
import { WorkerCheckpointScheduler } from "@/entrypoints/worker/checkpoint";
import { operationalMetrics } from "@/observability/metrics";
import { createStorageLayout } from "@/platform/filesystem/storage-layout";
import { atomicWriteFile } from "@/platform/filesystem/atomic-file";
import { openDatabase } from "@/platform/sqlite/connection";

function runtimeMode(): "development" | "production" | "test" {
  if (process.env.NODE_ENV === "production") return "production";
  if (process.env.NODE_ENV === "test") return "test";
  return "development";
}

export async function runWorkerMain(): Promise<void> {
  const shutdownController = new AbortController();
  const requestShutdown = (signal: NodeJS.Signals) => {
    if (!shutdownController.signal.aborted) shutdownController.abort(signal);
  };
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  // A supervised development worker must not outlive its Web process.
  process.once("disconnect", () => requestShutdown("SIGTERM"));

  const environment = parseEnvironment(process.env, { mode: runtimeMode() });
  const layout = await createStorageLayout(environment.dataDirectory);
  const databasePath = join(environment.dataDirectory, "db", "mirawind.sqlite");
  const database = openDatabase(databasePath, { role: "worker" });
  const pidPath = join(layout.temporaryDirectory, "worker.pid");
  try {
    const bootId = randomUUID();
    const workerId = `worker:${hostname()}:${process.pid}:${bootId}`;
    const repository = new JobRepository(database);
    const builds = new BuildRepository(database);
    await recoverWorkerAttempts({
      builds,
      database,
      nowMs: Date.now(),
      repository,
      storageRoot: layout.root,
    });
    const scheduler = new WorkerCheckpointScheduler({
      database,
      databasePath,
      layout,
    });
    const healthReporter = new WorkerHealthReporter(layout);
    const initialNowMs = Date.now();
    const checkpoint = await scheduler.checkpointIfDue(initialNowMs);
    if (checkpoint) healthReporter.recordCheckpoint(checkpoint, initialNowMs);
    healthReporter.recordQueue(
      repository.observeQueue(initialNowMs),
      initialNowMs,
    );
    await healthReporter.drain();
    await operationalMetrics.collectDiskUsage(layout.root);
    await atomicWriteFile(pidPath, `${process.pid}\n`, { mode: 0o600 });
    process.stdout.write("Mirawind worker ready\n");
    process.send?.({ type: "ready" });
    await runWorkerLoop({
      builds,
      database,
      drafts: new DraftRepository(database),
      imports: new ImportRepository(database),
      layout,
      onMaintenance: () => runWorkerMaintenance({ database, layout }),
      onIdle: () => runIdleReconciliation({ database, layout }),
      onAttemptObservation: (observation) =>
        healthReporter.recordAttempt(observation),
      onCheckpoint: (health, nowMs) =>
        healthReporter.recordCheckpoint(health, nowMs),
      onQueueObservation: (observation) =>
        healthReporter.recordQueue(observation),
      repository,
      scheduler,
      shutdownSignal: shutdownController.signal,
      workerId,
    });
    await healthReporter.drain();
  } finally {
    await rm(pidPath, { force: true });
    database.close();
    if (process.connected) process.disconnect();
  }
}
