import { describe, expect, it } from "vitest";

import { runWorkerLoop } from "@/composition/worker/loop";

describe("worker loop idle maintenance", () => {
  it("runs maintenance once after finding no user work", async () => {
    const shutdown = new AbortController();
    let claims = 0;
    let maintenanceRuns = 0;
    const repository = {
      claimNext() {
        claims += 1;
        return null;
      },
      interruptExpired: () => [],
      listPendingAutomaticRetries: () => [],
      observeQueue: (nowMs: number) => ({
        observedAtMs: nowMs,
        oldestQueuedAgeMs: null,
        queuedCount: 0,
        runningCount: 0 as const,
      }),
    };

    await runWorkerLoop({
      builds: {} as never,
      database: { prepare: () => ({ all: () => [] }) } as never,
      drafts: {} as never,
      imports: {} as never,
      layout: { root: "/tmp/unused-worker-loop-test" } as never,
      async onIdle() {
        maintenanceRuns += 1;
        shutdown.abort();
      },
      repository: repository as never,
      scheduler: { checkpointIfDue: async () => null } as never,
      shutdownSignal: shutdown.signal,
      workerId: "worker:test",
    });

    expect(claims).toBe(1);
    expect(maintenanceRuns).toBe(1);
  });
});
