import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { JobRepository } from "@/modules/publishing/adapters/sqlite/jobs";
import { serializeJobStatus } from "@/modules/publishing/adapters/sqlite/job-status";
import { openDatabase } from "@/platform/sqlite/connection";
import {
  createTemporaryDataRoot,
  type TemporaryDataRoot,
} from "../../helpers/data-root";
import { openMigratedTestDatabase } from "../../helpers/database";

const temporaryRoots: TemporaryDataRoot[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => root.cleanup()));
});

async function workerConnections(): Promise<
  readonly [Database.Database, Database.Database]
> {
  const root = await createTemporaryDataRoot("worker-leases");
  temporaryRoots.push(root);
  const migrated = await openMigratedTestDatabase(root);
  return [migrated.database, openDatabase(migrated.path, { role: "worker" })];
}

describe("two real worker connections sharing one SQLite queue", () => {
  it("enforces one global running job across claim, heartbeat and expiry", async () => {
    const [firstDatabase, secondDatabase] = await workerConnections();
    const firstWorker = new JobRepository(firstDatabase);
    const secondWorker = new JobRepository(secondDatabase);
    const firstJob = firstWorker.create({
      kind: "analyze_import",
      nowMs: 1_000,
    });
    const secondJob = firstWorker.create({
      kind: "prepare_draft",
      nowMs: 2_000,
    });
    expect(
      serializeJobStatus(
        {
          ...secondJob,
          progress: { ...secondJob.progress, completed: 0, total: 1 },
          state: "succeeded",
        },
        { kind: "system", label: "系统维护" },
      ),
    ).toMatchObject({
      kind: "prepare_draft",
      progress: { completed: 1, total: 1 },
    });

    const claimed = firstWorker.claimNext({
      leaseOwner: "worker-a",
      nowMs: 3_000,
    });
    expect(claimed).toMatchObject({
      id: firstJob.id,
      leaseUntilMs: 63_000,
      state: "running",
    });
    expect(
      secondWorker.claimNext({ leaseOwner: "worker-b", nowMs: 3_000 }),
    ).toBeNull();
    expect(() =>
      secondWorker.heartbeat({
        jobId: firstJob.id,
        leaseOwner: "worker-b",
        nowMs: 13_000,
      }),
    ).toThrow("JOB_LEASE_NOT_OWNED");

    expect(
      firstWorker.heartbeat({
        jobId: firstJob.id,
        leaseOwner: "worker-a",
        nowMs: 13_000,
        phase: "extract_archive",
        progress: {
          completed: 12,
          processed_bytes: null,
          total: 40,
          unit: "pages",
        },
      }),
    ).toMatchObject({
      heartbeatAtMs: 13_000,
      leaseUntilMs: 73_000,
      phase: "extract_archive",
      progress: { completed: 12, total: 40, unit: "pages" },
    });
    expect(secondWorker.interruptExpired({ nowMs: 73_000 })).toEqual([]);
    expect(secondWorker.interruptExpired({ nowMs: 73_001 })).toEqual([
      expect.objectContaining({
        errorClass: "infrastructure",
        errorCode: "JOB_LEASE_EXPIRED",
        id: firstJob.id,
        state: "interrupted",
      }),
    ]);

    expect(
      secondWorker.claimNext({ leaseOwner: "worker-b", nowMs: 73_002 }),
    ).toMatchObject({
      id: secondJob.id,
      state: "running",
    });
    firstDatabase.close();
    secondDatabase.close();
  });
});
