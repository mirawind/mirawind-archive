import { performance } from "node:perf_hooks";

import { isOpaqueId } from "@/domain/ids";
import {
  assertJobProgressUpdate,
  type JobKind,
  type JobErrorClass,
  type JobPhase,
  type JobProgress,
  type TerminalJobState,
} from "@/modules/publishing/application/publishing-api";

export interface ProcessTreeMemoryObservation {
  readonly failedSamples: number;
  readonly peakProcessTreeRssBytes: number | null;
  readonly sampleIntervalMs: number;
  readonly samples: number;
  readonly status: "available" | "unavailable";
}

export interface StageObservation {
  readonly durationMs: number;
  readonly phase: JobPhase;
  readonly progress: JobProgress;
  readonly startedAtMs: number;
  readonly status: "running" | "completed" | TerminalJobState;
}

export interface AttemptObservation {
  readonly attempt: number;
  readonly durationMs: number;
  readonly errorClass: JobErrorClass | null;
  readonly errorCode: string | null;
  readonly finishedAtMs: number | null;
  readonly jobId: string;
  readonly kind: JobKind;
  readonly memory: ProcessTreeMemoryObservation;
  readonly stages: readonly StageObservation[];
  readonly startedAtMs: number;
  readonly state: "running" | TerminalJobState;
}

interface MutableStage {
  phase: JobPhase;
  progress: JobProgress;
  startedAtMs: number;
  startedMonotonicMs: number;
}

const initialProgress: JobProgress = Object.freeze({
  completed: 0,
  processed_bytes: null,
  total: null,
  unit: "steps",
});

const unavailableMemory: ProcessTreeMemoryObservation = Object.freeze({
  failedSamples: 0,
  peakProcessTreeRssBytes: null,
  sampleIntervalMs: 250,
  samples: 0,
  status: "unavailable",
});

function safeDuration(value: number): number {
  return Math.max(0, Math.round(value * 1_000) / 1_000);
}

function validateMemory(value: ProcessTreeMemoryObservation): void {
  if (
    !Number.isSafeInteger(value.failedSamples) ||
    value.failedSamples < 0 ||
    !Number.isSafeInteger(value.samples) ||
    value.samples < 0 ||
    !Number.isSafeInteger(value.sampleIntervalMs) ||
    value.sampleIntervalMs < 1 ||
    (value.peakProcessTreeRssBytes !== null &&
      (!Number.isSafeInteger(value.peakProcessTreeRssBytes) ||
        value.peakProcessTreeRssBytes < 0)) ||
    (value.status === "available") !==
      (value.peakProcessTreeRssBytes !== null && value.samples > 0)
  ) {
    throw new Error("ATTEMPT_MEMORY_INVALID");
  }
}

export class AttemptObservationTracker {
  private readonly completedStages: StageObservation[] = [];
  private completed = false;
  private readonly startedMonotonicMs: number;
  private current: MutableStage;

  constructor(
    private readonly input: {
      readonly attempt: number;
      readonly jobId: string;
      readonly kind: JobKind;
      readonly monotonicNow?: () => number;
      readonly startedAtMs: number;
    },
  ) {
    if (
      !Number.isSafeInteger(input.attempt) ||
      input.attempt < 1 ||
      !isOpaqueId("job", input.jobId) ||
      !Number.isSafeInteger(input.startedAtMs) ||
      input.startedAtMs < 0
    ) {
      throw new Error("ATTEMPT_OBSERVATION_INPUT_INVALID");
    }
    this.startedMonotonicMs = this.now();
    this.current = {
      phase: "starting",
      progress: initialProgress,
      startedAtMs: input.startedAtMs,
      startedMonotonicMs: this.startedMonotonicMs,
    };
  }

  private now(): number {
    return this.input.monotonicNow
      ? this.input.monotonicNow()
      : performance.now();
  }

  private closeCurrent(
    now: number,
    status: StageObservation["status"],
  ): StageObservation {
    return Object.freeze({
      durationMs: safeDuration(now - this.current.startedMonotonicMs),
      phase: this.current.phase,
      progress: this.current.progress,
      startedAtMs: this.current.startedAtMs,
      status,
    });
  }

  recordProgress(input: {
    readonly phase: JobPhase;
    readonly progress: JobProgress;
  }): void {
    if (this.completed) throw new Error("ATTEMPT_OBSERVATION_COMPLETED");
    assertJobProgressUpdate({
      current: this.current.progress,
      currentPhase: this.current.phase,
      kind: this.input.kind,
      next: input.progress,
      nextPhase: input.phase,
    });
    if (input.phase === this.current.phase) {
      this.current.progress = input.progress;
      return;
    }
    const now = this.now();
    this.completedStages.push(this.closeCurrent(now, "completed"));
    this.current = {
      phase: input.phase,
      progress: input.progress,
      startedAtMs: Math.round(
        this.input.startedAtMs + safeDuration(now - this.startedMonotonicMs),
      ),
      startedMonotonicMs: now,
    };
  }

  snapshot(): AttemptObservation {
    const now = this.now();
    return Object.freeze({
      attempt: this.input.attempt,
      durationMs: safeDuration(now - this.startedMonotonicMs),
      errorClass: null,
      errorCode: null,
      finishedAtMs: null,
      jobId: this.input.jobId,
      kind: this.input.kind,
      memory: unavailableMemory,
      stages: Object.freeze([
        ...this.completedStages,
        this.closeCurrent(now, "running"),
      ]),
      startedAtMs: this.input.startedAtMs,
      state: "running",
    });
  }

  complete(input: {
    readonly errorClass: JobErrorClass | null;
    readonly errorCode: string | null;
    readonly finishedAtMs: number;
    readonly memory: ProcessTreeMemoryObservation;
    readonly state: TerminalJobState;
  }): AttemptObservation {
    if (this.completed) throw new Error("ATTEMPT_OBSERVATION_COMPLETED");
    validateMemory(input.memory);
    const now = this.now();
    this.completed = true;
    const stages = Object.freeze([
      ...this.completedStages,
      this.closeCurrent(now, input.state),
    ]);
    return Object.freeze({
      attempt: this.input.attempt,
      durationMs: safeDuration(now - this.startedMonotonicMs),
      errorClass: input.errorClass,
      errorCode: input.errorCode,
      finishedAtMs: input.finishedAtMs,
      jobId: this.input.jobId,
      kind: this.input.kind,
      memory: Object.freeze({ ...input.memory }),
      stages,
      startedAtMs: this.input.startedAtMs,
      state: input.state,
    });
  }
}
