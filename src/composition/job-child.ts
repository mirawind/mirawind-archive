import { isAbsolute, resolve, sep } from "node:path";

import { executeWorkerChildCommand } from "./worker-child/registry";
import { SafeApplicationError } from "@/domain/errors";
import {
  isCancelJobMessage,
  isRunJobMessage,
  jobChildProtocolVersion,
  type JobProgress,
  type JobProgressMessage,
  type JobResultMessage,
  type RunJobMessage,
} from "@/entrypoints/worker/protocol";
import { shouldReportJobProgress } from "@/entrypoints/worker/progress-throttle";
import {
  finishPipelineProfile,
  startPipelineProfile,
} from "@/observability/pipeline-profile";

let active: RunJobMessage | undefined;
const controller = new AbortController();
let lastProgressAt = 0;
let lastProgressPhase: string | null = null;

function send(result: JobResultMessage): void {
  void finishPipelineProfile(result.ok ? "passed" : "failed")
    .catch(() => undefined)
    .then(() => {
      process.send?.(result, () => {
        if (process.connected) process.disconnect();
      });
    });
}

function reportProgress(
  phase: JobProgressMessage["phase"],
  progress: JobProgress,
): void {
  if (!active) return;
  const now = Date.now();
  if (
    !shouldReportJobProgress({
      lastPhase: lastProgressPhase,
      lastReportedAtMs: lastProgressAt,
      nowMs: now,
      phase,
    })
  ) {
    return;
  }
  lastProgressAt = now;
  lastProgressPhase = phase;
  process.send?.({
    jobId: active.input.jobId,
    phase,
    progress,
    protocolVersion: jobChildProtocolVersion,
    type: "progress",
  } satisfies JobProgressMessage);
}

function storageRoot(): string {
  const value = process.env.MIRAWIND_JOB_STORAGE_ROOT;
  if (!value || !isAbsolute(value) || resolve(value) === sep) {
    throw new Error("JOB_STORAGE_ROOT_INVALID");
  }
  return resolve(value);
}

function safeErrorClass(
  error: unknown,
): NonNullable<JobResultMessage["safeErrorClass"]> {
  if (!(error instanceof SafeApplicationError)) return "infrastructure";
  if (error.code.includes("CANCELED")) return "canceled";
  if (error.code.includes("TIMEOUT")) return "timeout";
  if (error.code.includes("LIMIT")) {
    return "security_limit";
  }
  return "content";
}

function safeErrorCode(error: unknown): string {
  if (error instanceof SafeApplicationError) return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,79}$/u.test(error.message)) {
    return error.message;
  }
  return "JOB_HANDLER_FAILED";
}

async function execute(message: RunJobMessage): Promise<void> {
  try {
    await startPipelineProfile({
      jobId: message.input.jobId,
      jobKind: message.input.kind,
    });
    const outcome = await executeWorkerChildCommand(message.input, {
      reportProgress,
      root: storageRoot(),
      signal: controller.signal,
    });
    send({
      jobId: message.input.jobId,
      ok: outcome.ok,
      protocolVersion: jobChildProtocolVersion,
      ...(outcome.ok
        ? outcome.result
          ? { result: outcome.result }
          : {}
        : {
            safeErrorClass: outcome.safeErrorClass,
            safeErrorCode: outcome.safeErrorCode,
          }),
      type: "result",
    });
  } catch (error) {
    send({
      jobId: message.input.jobId,
      ok: false,
      protocolVersion: jobChildProtocolVersion,
      safeErrorClass: safeErrorClass(error),
      safeErrorCode: safeErrorCode(error),
      type: "result",
    });
  }
}

process.on("message", (message: unknown) => {
  if (isCancelJobMessage(message)) {
    if (active?.input.jobId === message.jobId) controller.abort();
    return;
  }
  if (!isRunJobMessage(message) || active) {
    send({
      jobId:
        typeof message === "object" &&
        message !== null &&
        "jobId" in message &&
        typeof message.jobId === "string"
          ? message.jobId
          : "job_invalid",
      ok: false,
      protocolVersion: jobChildProtocolVersion,
      safeErrorClass: "infrastructure",
      safeErrorCode: "INVALID_JOB_CHILD_REQUEST",
      type: "result",
    });
    return;
  }
  active = message;
  if (controller.signal.aborted) {
    send({
      jobId: message.input.jobId,
      ok: false,
      protocolVersion: jobChildProtocolVersion,
      safeErrorClass: "canceled",
      safeErrorCode: "JOB_CANCELED",
      type: "result",
    });
    return;
  }
  void execute(message);
});
