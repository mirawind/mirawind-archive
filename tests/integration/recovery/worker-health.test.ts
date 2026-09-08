import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkerHealthReporter } from "@/composition/worker/health-reporter";
import { createOpaqueId } from "@/domain/ids";
import { AttemptObservationTracker } from "@/observability/attempt-observation";
import {
  readWorkerHealthSnapshot,
  WorkerHealthFileReporter,
  type WorkerHealthSnapshot,
} from "@/observability/worker-health";
import {
  createTemporaryDataRoot,
  type TemporaryDataRoot,
} from "../../helpers/data-root";

const roots: TemporaryDataRoot[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => root.cleanup()));
});

function health(queuedCount = 0): WorkerHealthSnapshot {
  return {
    checkedAt: "2026-08-23T00:00:00.000Z",
    checkpoint: {
      busy: 0,
      checkpointedPages: 1,
      logPages: 1,
      mode: "PASSIVE",
    },
    currentAttempt: null,
    lease: { activeJobs: 0, earliestExpiry: null },
    queue: {
      observedAtMs: 1_000,
      oldestQueuedAgeMs: queuedCount === 0 ? null : 100,
      queuedCount,
      runningCount: 0,
    },
    recentAttempt: null,
    schemaVersion: 2,
    status: "healthy",
    walBytes: 0,
    warnings: [],
  };
}

describe("worker health derived snapshot", () => {
  it("writes atomically with mode 0600 and coalesces repeated snapshots", async () => {
    const root = await createTemporaryDataRoot("worker-health");
    roots.push(root);
    const path = resolve(root.layout.temporaryDirectory, "worker-health.json");
    const reporter = new WorkerHealthFileReporter(path);

    await expect(reporter.writeIfDue(health(), 1_000)).resolves.toBe("written");
    await expect(reporter.writeIfDue(health(), 1_100)).resolves.toBe(
      "unchanged",
    );
    await expect(reporter.writeIfDue(health(1), 1_500)).resolves.toBe(
      "deferred",
    );
    await expect(reporter.writeIfDue(health(1), 2_000)).resolves.toBe(
      "written",
    );

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readWorkerHealthSnapshot(path)).toMatchObject({
      queue: { queuedCount: 1 },
      schemaVersion: 2,
    });
  });

  it("rejects the old unversioned shape, unknown fields and oversized files", async () => {
    const root = await createTemporaryDataRoot("worker-health-invalid");
    roots.push(root);
    const path = resolve(root.layout.temporaryDirectory, "worker-health.json");

    await writeFile(path, JSON.stringify({ status: "healthy" }));
    await expect(readWorkerHealthSnapshot(path)).resolves.toBeNull();
    await writeFile(
      path,
      JSON.stringify({ ...health(), originalName: "private.zip" }),
    );
    await expect(readWorkerHealthSnapshot(path)).resolves.toBeNull();
    await writeFile(path, "x".repeat(64 * 1_024 + 1));
    await expect(readWorkerHealthSnapshot(path)).resolves.toBeNull();
  });

  it("contains only strict safe fields and treats write failure as unavailable", async () => {
    const writes: string[] = [];
    const reporter = new WorkerHealthFileReporter(
      "/private/worker-health.json",
      {
        async write(_path, value) {
          writes.push(value);
          throw new Error("disk unavailable");
        },
      },
    );
    await expect(reporter.writeIfDue(health(), 1_000)).resolves.toBe(
      "unavailable",
    );
    expect(writes[0]).not.toContain("private.zip");
  });

  it("emits canonical bounded JSON", async () => {
    const root = await createTemporaryDataRoot("worker-health-json");
    roots.push(root);
    const path = resolve(root.layout.temporaryDirectory, "worker-health.json");
    const reporter = new WorkerHealthFileReporter(path);
    await reporter.writeIfDue(health(), 1_000);
    const bytes = await readFile(path);
    expect(bytes.byteLength).toBeLessThanOrEqual(64 * 1_024);
    expect(bytes.toString("utf8").endsWith("\n")).toBe(true);
  });

  it("publishes current and recent attempt stages through the single reporter", async () => {
    const root = await createTemporaryDataRoot("worker-health-attempt");
    roots.push(root);
    const reporter = new WorkerHealthReporter(root.layout);
    const nowMs = Date.now();
    reporter.recordCheckpoint(
      {
        checkpoint: {
          busy: 0,
          checkpointedPages: 0,
          logPages: 0,
          mode: "PASSIVE",
        },
        checkedAt: new Date(nowMs).toISOString(),
        lease: { activeJobs: 1, earliestExpiry: null },
        status: "healthy",
        walBytes: 0,
        warnings: [],
      },
      nowMs,
    );
    reporter.recordQueue(
      {
        observedAtMs: nowMs,
        oldestQueuedAgeMs: null,
        queuedCount: 0,
        runningCount: 1,
      },
      nowMs,
    );
    let monotonic = 0;
    const tracker = new AttemptObservationTracker({
      attempt: 1,
      jobId: createOpaqueId("job"),
      kind: "prepare_draft",
      monotonicNow: () => monotonic,
      startedAtMs: nowMs,
    });
    monotonic = 4.25;
    tracker.recordProgress({
      phase: "extract_archive",
      progress: {
        completed: 0,
        processed_bytes: null,
        total: 1,
        unit: "steps",
      },
    });
    reporter.recordAttempt(tracker.snapshot(), nowMs + 5);
    monotonic = 9.5;
    reporter.recordAttempt(
      tracker.complete({
        errorClass: null,
        errorCode: null,
        finishedAtMs: nowMs + 10,
        memory: {
          failedSamples: 0,
          peakProcessTreeRssBytes: 8_192,
          sampleIntervalMs: 250,
          samples: 2,
          status: "available",
        },
        state: "succeeded",
      }),
      nowMs + 10,
    );
    await reporter.drain();

    const stored = await readWorkerHealthSnapshot(
      resolve(root.layout.temporaryDirectory, "worker-health.json"),
    );
    expect(stored?.currentAttempt).toBeNull();
    expect(stored?.recentAttempt).toMatchObject({
      durationMs: 9.5,
      memory: { peakProcessTreeRssBytes: 8_192 },
      stages: [
        { durationMs: 4.25, phase: "starting" },
        { durationMs: 5.25, phase: "extract_archive" },
      ],
      state: "succeeded",
    });
  });
});
