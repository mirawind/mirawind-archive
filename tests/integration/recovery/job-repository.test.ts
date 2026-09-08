import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { JobRepository } from "@/modules/publishing/adapters/sqlite/jobs";
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

async function connections(): Promise<[Database.Database, Database.Database]> {
  const root = await createTemporaryDataRoot("jobs");
  temporaryRoots.push(root);
  const migrated = await openMigratedTestDatabase(root);
  return [migrated.database, openDatabase(migrated.path, { role: "worker" })];
}

describe("durable job repository", () => {
  it("allows only one claimant to atomically acquire a queued job", async () => {
    const [firstDatabase, secondDatabase] = await connections();
    const first = new JobRepository(firstDatabase);
    const second = new JobRepository(secondDatabase);
    const job = first.create({ kind: "analyze_import" });

    const claimed = [
      first.claimNext({ leaseOwner: "worker-a", nowMs: 1_000 }),
      second.claimNext({ leaseOwner: "worker-b", nowMs: 1_000 }),
    ].filter(Boolean);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(job.id);
    firstDatabase.close();
    secondDatabase.close();
  });

  it("uses a 10-second heartbeat and expires a lease after 60 seconds", async () => {
    const [database, secondDatabase] = await connections();
    const repository = new JobRepository(database);
    repository.create({ kind: "analyze_import" });
    const claimed = repository.claimNext({
      leaseOwner: "worker-a",
      nowMs: 1_000,
    });
    expect(claimed?.leaseUntilMs).toBe(61_000);
    if (!claimed) throw new Error("Expected the queued job to be claimed");

    expect(
      repository.heartbeat({
        jobId: claimed.id,
        leaseOwner: "worker-a",
        nowMs: 11_000,
      }).leaseUntilMs,
    ).toBe(71_000);
    expect(repository.interruptExpired({ nowMs: 71_001 })).toHaveLength(1);
    database.close();
    secondDatabase.close();
  });

  it("creates an immutable retry attempt instead of overwriting history", async () => {
    const [database, secondDatabase] = await connections();
    const repository = new JobRepository(database);
    const original = repository.create({ kind: "analyze_import" });
    repository.fail(original.id, {
      errorClass: "infrastructure",
      errorCode: "WORKER_EXIT",
      nowMs: 2_000,
    });

    const retry = repository.retry(original.id, {
      automatic: true,
      nowMs: 3_000,
    });
    expect(retry).toMatchObject({
      attempt: 2,
      automaticRetryCount: 1,
      retryOfJobId: original.id,
      state: "queued",
    });
    expect(repository.get(original.id)).toMatchObject({
      state: "failed",
      attempt: 1,
    });
    database.close();
    secondDatabase.close();
  });

  it("deduplicates creation by an operation-scoped hashed idempotency key", async () => {
    const [database, secondDatabase] = await connections();
    const repository = new JobRepository(database);
    const input = {
      idempotency: {
        key: "client-generated-key-0001",
        operation: "import.analyze",
      },
      kind: "analyze_import" as const,
      nowMs: 1_000,
    };
    const first = repository.create(input);
    const duplicate = repository.create({ ...input, nowMs: 2_000 });

    expect(duplicate.id).toBe(first.id);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM jobs").get(),
    ).toEqual({ count: 1 });
    const stored = database
      .prepare("SELECT key_sha256 FROM job_idempotency_keys")
      .get() as { key_sha256: string };
    expect(stored.key_sha256).toHaveLength(64);
    expect(stored.key_sha256).not.toContain(input.idempotency.key);
    database.close();
    secondDatabase.close();
  });

  it("cancels queued work immediately and records running cancellation requests", async () => {
    const [database, secondDatabase] = await connections();
    const repository = new JobRepository(database);
    const queued = repository.create({
      kind: "analyze_import",
      nowMs: 1_000,
    });
    expect(repository.requestCancellation(queued.id, 2_000)).toMatchObject({
      errorClass: "canceled",
      errorCode: "JOB_CANCELED",
      finishedAtMs: 2_000,
      cancellationRequestedAtMs: 2_000,
      state: "canceled",
    });

    const running = repository.create({
      kind: "analyze_import",
      nowMs: 3_000,
    });
    repository.claimNext({ leaseOwner: "worker-a", nowMs: 4_000 });
    expect(repository.requestCancellation(running.id, 5_000)).toMatchObject({
      finishedAtMs: null,
      cancellationRequestedAtMs: 5_000,
      state: "running",
    });
    expect(
      repository.completeFailure({
        errorClass: "canceled",
        errorCode: "JOB_CANCELED",
        jobId: running.id,
        leaseOwner: "worker-a",
        nowMs: 6_000,
      }),
    ).toMatchObject({ finishedAtMs: 6_000, state: "canceled" });
    database.close();
    secondDatabase.close();
  });

  it("persists bounded progress and completes only for the lease owner", async () => {
    const [database, secondDatabase] = await connections();
    const repository = new JobRepository(database);
    const job = repository.create({
      kind: "analyze_import",
      nowMs: 1_000,
    });
    repository.claimNext({ leaseOwner: "worker-a", nowMs: 2_000 });
    expect(
      repository.heartbeat({
        jobId: job.id,
        leaseOwner: "worker-a",
        nowMs: 12_000,
        phase: "extract_archive",
        progress: {
          completed: 12,
          processed_bytes: null,
          total: 20,
          unit: "items",
        },
      }),
    ).toMatchObject({
      phase: "extract_archive",
      progress: { completed: 12, total: 20, unit: "items" },
    });
    expect(() =>
      repository.completeSuccess({
        jobId: job.id,
        leaseOwner: "worker-b",
        nowMs: 13_000,
      }),
    ).toThrow();
    expect(
      repository.completeSuccess({
        jobId: job.id,
        leaseOwner: "worker-a",
        nowMs: 14_000,
      }),
    ).toMatchObject({
      finishedAtMs: 14_000,
      leaseOwner: null,
      progress: { completed: 20, total: 20, unit: "items" },
      state: "succeeded",
    });
    expect(() =>
      repository.heartbeat({
        jobId: job.id,
        leaseOwner: "worker-a",
        nowMs: 22_000,
      }),
    ).toThrow();
    database.close();
    secondDatabase.close();
  });

  it("rejects decreasing or incompatible progress within one phase", async () => {
    const [database, secondDatabase] = await connections();
    const repository = new JobRepository(database);
    const job = repository.create({ kind: "prepare_draft", nowMs: 1_000 });
    repository.claimNext({ leaseOwner: "worker-a", nowMs: 2_000 });
    repository.heartbeat({
      jobId: job.id,
      leaseOwner: "worker-a",
      nowMs: 3_000,
      phase: "extract_archive",
      progress: {
        completed: 12,
        processed_bytes: 1_024,
        total: 20,
        unit: "items",
      },
    });

    for (const progress of [
      {
        completed: 11,
        processed_bytes: 1_024,
        total: 20,
        unit: "items" as const,
      },
      {
        completed: 12,
        processed_bytes: 1_023,
        total: 20,
        unit: "items" as const,
      },
      {
        completed: 12,
        processed_bytes: 1_024,
        total: 21,
        unit: "items" as const,
      },
      {
        completed: 12,
        processed_bytes: 1_024,
        total: 20,
        unit: "bytes" as const,
      },
    ]) {
      expect(() =>
        repository.heartbeat({
          jobId: job.id,
          leaseOwner: "worker-a",
          nowMs: 4_000,
          phase: "extract_archive",
          progress,
        }),
      ).toThrow(/JOB_PROGRESS_/u);
    }
    database.close();
    secondDatabase.close();
  });

  it("rejects a phase that moves backward within one attempt", async () => {
    const [database, secondDatabase] = await connections();
    const repository = new JobRepository(database);
    const job = repository.create({ kind: "prepare_draft", nowMs: 1_000 });
    repository.claimNext({ leaseOwner: "worker-a", nowMs: 2_000 });
    repository.heartbeat({
      jobId: job.id,
      leaseOwner: "worker-a",
      nowMs: 3_000,
      phase: "organize_structure",
    });

    expect(() =>
      repository.heartbeat({
        jobId: job.id,
        leaseOwner: "worker-a",
        nowMs: 4_000,
        phase: "identify_document",
      }),
    ).toThrow("JOB_PHASE_REGRESSION");
    database.close();
    secondDatabase.close();
  });

  it("observes empty, queued, running and draining queue states", async () => {
    const [database, secondDatabase] = await connections();
    const repository = new JobRepository(database);
    expect(repository.observeQueue(1_000)).toEqual({
      observedAtMs: 1_000,
      oldestQueuedAgeMs: null,
      queuedCount: 0,
      runningCount: 0,
    });
    const first = repository.create({ kind: "analyze_import", nowMs: 1_100 });
    repository.create({ kind: "prepare_draft", nowMs: 1_200 });
    expect(repository.observeQueue(2_000)).toMatchObject({
      oldestQueuedAgeMs: 900,
      queuedCount: 2,
      runningCount: 0,
    });
    repository.claimNext({ leaseOwner: "worker-a", nowMs: 2_100 });
    expect(repository.observeQueue(2_200)).toMatchObject({
      oldestQueuedAgeMs: 1_000,
      queuedCount: 1,
      runningCount: 1,
    });
    repository.completeSuccess({
      jobId: first.id,
      leaseOwner: "worker-a",
      nowMs: 2_300,
    });
    expect(repository.observeQueue(1_000)).toMatchObject({
      oldestQueuedAgeMs: 0,
      queuedCount: 1,
      runningCount: 0,
    });
    database.close();
    secondDatabase.close();
  });

  it("allows only one automatic retry across an immutable retry chain", async () => {
    const [database, secondDatabase] = await connections();
    const repository = new JobRepository(database);
    const original = repository.create({
      kind: "analyze_import",
      nowMs: 1_000,
    });
    repository.fail(original.id, {
      errorClass: "infrastructure",
      errorCode: "WORKER_EXIT",
      nowMs: 2_000,
    });
    const automatic = repository.retry(original.id, {
      automatic: true,
      nowMs: 3_000,
    });
    repository.fail(automatic.id, {
      errorClass: "infrastructure",
      errorCode: "WORKER_EXIT",
      nowMs: 4_000,
    });
    expect(() =>
      repository.retry(automatic.id, {
        automatic: true,
        nowMs: 5_000,
      }),
    ).toThrow("AUTOMATIC_RETRY_LIMIT_EXCEEDED");
    expect(
      repository.retry(automatic.id, {
        automatic: false,
        nowMs: 6_000,
      }),
    ).toMatchObject({
      attempt: 3,
      automaticRetryCount: 1,
      retryOfJobId: automatic.id,
    });
    database.close();
    secondDatabase.close();
  });
});
