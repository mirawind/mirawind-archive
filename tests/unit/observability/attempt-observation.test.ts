import { describe, expect, it } from "vitest";

import { createOpaqueId } from "@/domain/ids";
import { AttemptObservationTracker } from "@/observability/attempt-observation";

function progress(completed: number, total = 3) {
  return Object.freeze({
    completed,
    processed_bytes: null,
    total,
    unit: "steps" as const,
  });
}

describe("worker attempt observation", () => {
  it("uses the bound Node performance clock by default", () => {
    const tracker = new AttemptObservationTracker({
      attempt: 1,
      jobId: createOpaqueId("job"),
      kind: "analyze_import",
      startedAtMs: Date.now(),
    });
    expect(tracker.snapshot()).toMatchObject({ state: "running" });
  });

  it("uses monotonic time and closes contiguous stages exactly once", () => {
    let now = 10;
    const tracker = new AttemptObservationTracker({
      attempt: 1,
      jobId: createOpaqueId("job"),
      kind: "prepare_draft",
      monotonicNow: () => now,
      startedAtMs: 1_000,
    });
    now = 30;
    tracker.recordProgress({ phase: "extract_archive", progress: progress(0) });
    now = 40;
    tracker.recordProgress({ phase: "extract_archive", progress: progress(1) });
    now = 70;
    tracker.recordProgress({
      phase: "identify_document",
      progress: progress(2),
    });
    now = 100;
    const completed = tracker.complete({
      errorClass: null,
      errorCode: null,
      finishedAtMs: 1_090,
      memory: {
        failedSamples: 0,
        peakProcessTreeRssBytes: 4_096,
        sampleIntervalMs: 250,
        samples: 3,
        status: "available",
      },
      state: "succeeded",
    });

    expect(completed.durationMs).toBe(90);
    expect(completed.stages).toEqual([
      expect.objectContaining({
        durationMs: 20,
        phase: "starting",
        status: "completed",
      }),
      expect.objectContaining({
        durationMs: 40,
        phase: "extract_archive",
        progress: progress(1),
        status: "completed",
      }),
      expect.objectContaining({
        durationMs: 30,
        phase: "identify_document",
        status: "succeeded",
      }),
    ]);
    expect(completed.memory.peakProcessTreeRssBytes).toBe(4_096);
  });

  it.each([
    ["failed", "content", "ARCHIVE_INVALID"],
    ["canceled", "canceled", "JOB_CANCELED"],
    ["interrupted", "infrastructure", "WORKER_SHUTDOWN"],
  ] as const)(
    "records the %s terminal classification",
    (state, errorClass, errorCode) => {
      let now = 0;
      const tracker = new AttemptObservationTracker({
        attempt: 2,
        jobId: createOpaqueId("job"),
        kind: "analyze_import",
        monotonicNow: () => now,
        startedAtMs: 2_000,
      });
      now = 5;
      tracker.recordProgress({
        phase: "extract_archive",
        progress: progress(0, 2),
      });
      now = 9;
      expect(
        tracker.complete({
          errorClass,
          errorCode,
          finishedAtMs: 2_009,
          memory: {
            failedSamples: 1,
            peakProcessTreeRssBytes: null,
            sampleIntervalMs: 250,
            samples: 0,
            status: "unavailable",
          },
          state,
        }),
      ).toMatchObject({
        attempt: 2,
        durationMs: 9,
        errorClass,
        errorCode,
        state,
      });
    },
  );

  it("keeps retries isolated and rejects a backward phase", () => {
    const first = new AttemptObservationTracker({
      attempt: 1,
      jobId: createOpaqueId("job"),
      kind: "prepare_draft",
      monotonicNow: () => 10,
      startedAtMs: 1_000,
    });
    first.recordProgress({
      phase: "organize_structure",
      progress: progress(3),
    });
    expect(() =>
      first.recordProgress({
        phase: "identify_document",
        progress: progress(2),
      }),
    ).toThrow("JOB_PHASE_REGRESSION");

    const retry = new AttemptObservationTracker({
      attempt: 2,
      jobId: createOpaqueId("job"),
      kind: "prepare_draft",
      monotonicNow: () => 0,
      startedAtMs: 2_000,
    });
    expect(retry.snapshot()).toMatchObject({
      attempt: 2,
      stages: [{ phase: "starting" }],
    });
  });
});
