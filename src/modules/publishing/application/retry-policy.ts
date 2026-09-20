import {
  isTerminalJobState,
  isJobErrorClass,
  type JobKind,
  type JobState,
} from "./job-state";

export interface RetryableJob {
  readonly automaticRetryCount: number;
  readonly cancellationRequestedAtMs: number | null;
  readonly errorClass: string | null;
  readonly errorCode: string | null;
  readonly kind: JobKind;
  readonly state: JobState;
}

export type JobRetryMode = "automatic" | "manual";

export type JobRetryDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{
      allowed: false;
      reason:
        | "AUTOMATIC_RETRY_NOT_INFRASTRUCTURE_INTERRUPTION"
        | "AUTOMATIC_RETRY_LIMIT_REACHED"
        | "JOB_NOT_RETRYABLE";
    }>;

export function evaluateJobRetry(
  job: RetryableJob,
  mode: JobRetryMode,
): JobRetryDecision {
  if (!isTerminalJobState(job.state) || job.state === "succeeded") {
    return { allowed: false, reason: "JOB_NOT_RETRYABLE" };
  }

  if (mode === "automatic") {
    if (job.automaticRetryCount >= 1) {
      return {
        allowed: false,
        reason: "AUTOMATIC_RETRY_LIMIT_REACHED",
      };
    }
    if (
      job.cancellationRequestedAtMs !== null ||
      job.state !== "interrupted" ||
      job.errorClass !== "infrastructure" ||
      !["JOB_LEASE_EXPIRED", "WORKER_SHUTDOWN"].includes(job.errorCode ?? "")
    ) {
      return {
        allowed: false,
        reason: "AUTOMATIC_RETRY_NOT_INFRASTRUCTURE_INTERRUPTION",
      };
    }
    return { allowed: true };
  }

  return isJobErrorClass(job.errorClass)
    ? { allowed: true }
    : { allowed: false, reason: "JOB_NOT_RETRYABLE" };
}
