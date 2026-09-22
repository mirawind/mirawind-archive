import type Database from "better-sqlite3";

import { reconcileStorage } from "../storage-reconciliation";
import { BookPresentationRepository } from "@/modules/catalog/adapters/sqlite/book-presentations";
import {
  reclaimRetainedStorage,
  reclaimQuarantine,
} from "@/modules/publishing/adapters/worker/reclaim";
import { operationalMetrics } from "@/observability/metrics";
import type { StorageLayout } from "@/platform/filesystem/storage-layout";

async function runStep(
  name: "maintenance.reclaim" | "maintenance.reconcile",
  operation: () => Promise<void>,
): Promise<void> {
  const startedAtMs = Date.now();
  try {
    await operation();
    operationalMetrics.recordTransition(`${name}.succeeded`);
  } catch {
    operationalMetrics.recordFailure(
      "infrastructure",
      name.toUpperCase().replaceAll(".", "_"),
    );
    process.stderr.write(
      `Mirawind worker ${name} failed; retrying next maintenance\n`,
    );
  } finally {
    operationalMetrics.recordPhase(name, Date.now() - startedAtMs);
  }
}

export async function runWorkerMaintenance(input: {
  readonly database: Database.Database;
  readonly layout: StorageLayout;
}): Promise<void> {
  await runStep("maintenance.reclaim", async () => {
    const outcome = await reclaimRetainedStorage({
      ...input,
      nowMs: Date.now(),
      presentationRemover: new BookPresentationRepository(input.database),
    });
    if (outcome.failedPaths.length > 0)
      throw new Error("RECLAIM_CLEANUP_INCOMPLETE");
  });
}

export async function runIdleReconciliation(input: {
  readonly database: Database.Database;
  readonly layout: StorageLayout;
}): Promise<void> {
  await runStep("maintenance.reconcile", async () => {
    const outcome = await reconcileStorage({
      ...input,
      nowMs: Date.now(),
    });
    if (
      outcome.corruptDatabaseVersions.length > 0 ||
      outcome.quarantinedDirectories.length > 0 ||
      outcome.recoveredCurrentVersions.length > 0 ||
      outcome.removedOrphanPaths.length > 0 ||
      outcome.removedStagingDirectories.length > 0
    ) {
      operationalMetrics.recordTransition("recovery.maintenance_changed");
    }
  });
  await runStep("maintenance.reclaim", async () => {
    const outcome = await reclaimQuarantine({
      layout: input.layout,
      nowMs: Date.now(),
    });
    if (outcome.failed.length > 0) {
      throw new Error("RECLAIM_CLEANUP_INCOMPLETE");
    }
  });
}
