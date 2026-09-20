export const userJobKinds = [
  "analyze_import",
  "prepare_draft",
  "build_book",
  "purge_book",
] as const;

export const jobKinds = userJobKinds;

export const jobErrorClasses = [
  "infrastructure",
  "content",
  "validation",
  "timeout",
  "canceled",
] as const;
export type JobErrorClass = (typeof jobErrorClasses)[number];
export function isJobErrorClass(value: unknown): value is JobErrorClass {
  return (
    typeof value === "string" &&
    (jobErrorClasses as readonly string[]).includes(value)
  );
}

export type JobKind = (typeof jobKinds)[number];
export type UserJobKind = (typeof userJobKinds)[number];
export type JobState =
  "queued" | "running" | "succeeded" | "failed" | "canceled" | "interrupted";
export type TerminalJobState = Extract<
  JobState,
  "succeeded" | "failed" | "canceled" | "interrupted"
>;

export type JobProgressUnit = "bytes" | "items" | "pages" | "steps";

export interface JobProgress {
  readonly completed: number;
  readonly processed_bytes: number | null;
  readonly total: number | null;
  readonly unit: JobProgressUnit;
}

export interface QueueObservation {
  readonly observedAtMs: number;
  readonly oldestQueuedAgeMs: number | null;
  readonly queuedCount: number;
  readonly runningCount: 0 | 1;
}

const terminalPhases = [
  "complete",
  "failed",
  "canceled",
  "interrupted",
] as const;

const jobPhases = Object.freeze({
  analyze_import: [
    "queued",
    "starting",
    "extract_archive",
    "identify_document",
    ...terminalPhases,
  ],
  prepare_draft: [
    "queued",
    "starting",
    "extract_archive",
    "identify_document",
    "organize_structure",
    ...terminalPhases,
  ],
  build_book: [
    "queued",
    "starting",
    "compile_book",
    "render_pages",
    "build_search",
    "finalize_build",
    ...terminalPhases,
  ],
  purge_book: [
    "queued",
    "starting",
    "permanent_book_deletion",
    ...terminalPhases,
  ],
} satisfies Readonly<Record<JobKind, readonly string[]>>);

export type JobPhase = (typeof jobPhases)[JobKind][number];

const knownJobPhases = new Set<string>(Object.values(jobPhases).flat());

export function isKnownJobPhase(phase: string): phase is JobPhase {
  return knownJobPhases.has(phase);
}

export function isUserJobKind(kind: JobKind): kind is UserJobKind {
  return userJobKinds.includes(kind as UserJobKind);
}

export function isJobPhase(kind: JobKind, phase: string): phase is JobPhase {
  return jobPhases[kind].includes(phase as never);
}

export function assertJobPhase(kind: JobKind, phase: string): void {
  if (!isJobPhase(kind, phase)) {
    throw new Error(`JOB_PHASE_INVALID:${kind}:${phase}`);
  }
}

export function isJobProgress(value: unknown): value is JobProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    Object.keys(record).some(
      (key) => !["completed", "processed_bytes", "total", "unit"].includes(key),
    )
  ) {
    return false;
  }
  const { completed, processed_bytes: processedBytes, total, unit } = record;
  return (
    typeof completed === "number" &&
    Number.isSafeInteger(completed) &&
    completed >= 0 &&
    (total === null ||
      (typeof total === "number" &&
        Number.isSafeInteger(total) &&
        total >= completed)) &&
    (processedBytes === null ||
      (typeof processedBytes === "number" &&
        Number.isSafeInteger(processedBytes) &&
        processedBytes >= 0)) &&
    ["bytes", "items", "pages", "steps"].includes(String(unit))
  );
}

export function assertJobProgressUpdate(input: {
  readonly current: JobProgress;
  readonly currentPhase: string;
  readonly kind: JobKind;
  readonly next: JobProgress;
  readonly nextPhase: string;
}): void {
  assertJobPhase(input.kind, input.currentPhase);
  assertJobPhase(input.kind, input.nextPhase);
  if (!isJobProgress(input.current) || !isJobProgress(input.next)) {
    throw new Error("JOB_PROGRESS_INVALID");
  }
  const phases = jobPhases[input.kind];
  const currentIndex = phases.indexOf(input.currentPhase as never);
  const nextIndex = phases.indexOf(input.nextPhase as never);
  if (nextIndex < currentIndex) throw new Error("JOB_PHASE_REGRESSION");
  if (input.currentPhase !== input.nextPhase) return;
  if (input.next.unit !== input.current.unit) {
    throw new Error("JOB_PROGRESS_UNIT_CHANGED");
  }
  if (
    input.current.total !== null &&
    input.next.total !== input.current.total
  ) {
    throw new Error("JOB_PROGRESS_TOTAL_CHANGED");
  }
  if (input.next.completed < input.current.completed) {
    throw new Error("JOB_PROGRESS_COMPLETED_REGRESSION");
  }
  if (
    input.current.processed_bytes !== null &&
    (input.next.processed_bytes === null ||
      input.next.processed_bytes < input.current.processed_bytes)
  ) {
    throw new Error("JOB_PROGRESS_BYTES_REGRESSION");
  }
}

const transitions: Readonly<Record<JobState, readonly JobState[]>> = {
  canceled: [],
  failed: [],
  interrupted: [],
  queued: ["running", "canceled"],
  running: ["succeeded", "failed", "canceled", "interrupted"],
  succeeded: [],
};

function canTransitionJob(current: JobState, next: JobState): boolean {
  return transitions[current].includes(next);
}

export function assertJobTransition(current: JobState, next: JobState): void {
  if (!canTransitionJob(current, next)) {
    throw new Error(`JOB_TRANSITION_FORBIDDEN:${current}:${next}`);
  }
}

export function isTerminalJobState(state: JobState): state is TerminalJobState {
  return transitions[state].length === 0;
}
