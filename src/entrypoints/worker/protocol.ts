import { isOpaqueId } from "@/domain/ids";
import {
  isKnownJobPhase,
  isJobProgress,
  userJobKinds,
  parseBuildBookCommand,
  type BuildBookCommand,
  type JobPhase,
  type JobProgress,
  type JobProgressUnit,
} from "@/modules/publishing/application/publishing-api";

export const jobChildProtocolVersion = 7;

interface FrozenJobCommandBase {
  readonly attempt: number;
  readonly createdAtMs: number;
  readonly jobId: string;
  readonly stagingRelativePath: string;
}

export interface AnalyzeImportCommand extends FrozenJobCommandBase {
  readonly importId: string;
  readonly importUploadRelativePath: string;
  readonly kind: "analyze_import";
}

export interface PrepareDraftCommand extends FrozenJobCommandBase {
  readonly bookId: number;
  readonly importId: string;
  readonly importUploadRelativePath: string;
  readonly kind: "prepare_draft";
  readonly sourceRelativePath: string;
}

export interface PurgeBookCommand extends FrozenJobCommandBase {
  readonly bookId: number;
  readonly kind: "purge_book";
}

export type FrozenJobInput =
  | AnalyzeImportCommand
  | BuildBookCommand
  | PrepareDraftCommand
  | PurgeBookCommand;

export interface RunJobMessage {
  readonly input: FrozenJobInput;
  readonly protocolVersion: typeof jobChildProtocolVersion;
  readonly type: "run";
}

export interface CancelJobMessage {
  readonly jobId: string;
  readonly protocolVersion: typeof jobChildProtocolVersion;
  readonly type: "cancel";
}

export type ParentToChildMessage = CancelJobMessage | RunJobMessage;

export interface JobProgressMessage {
  readonly jobId: string;
  readonly phase: JobPhase;
  readonly progress: JobProgress;
  readonly protocolVersion: typeof jobChildProtocolVersion;
  readonly type: "progress";
}

export type { JobProgress, JobProgressUnit };

export interface JobResultMessage {
  readonly jobId: string;
  readonly ok: boolean;
  readonly protocolVersion: typeof jobChildProtocolVersion;
  readonly result?: Readonly<Record<string, string | number | boolean | null>>;
  readonly safeErrorClass?:
    | "infrastructure"
    | "content"
    | "validation"
    | "security_limit"
    | "timeout"
    | "canceled";
  readonly safeErrorCode?: string;
  readonly type: "result";
}

export type ChildToParentMessage = JobProgressMessage | JobResultMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isNullablePositiveInteger(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 1)
  );
}

function isSafeScalarRecord(
  value: unknown,
): value is Record<string, string | number | boolean | null> {
  if (!isRecord(value) || Object.keys(value).length > 100) return false;
  return Object.entries(value).every(
    ([key, item]) =>
      key.length >= 1 &&
      key.length <= 80 &&
      (item === null ||
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean") &&
      (typeof item !== "string" || item.length <= 500) &&
      (typeof item !== "number" || Number.isFinite(item)),
  );
}

export { isJobProgress };

export function isRunJobMessage(value: unknown): value is RunJobMessage {
  if (!isRecord(value) || value.type !== "run") return false;
  if (value.protocolVersion !== jobChildProtocolVersion) return false;
  const input = value.input;
  if (!isRecord(input)) return false;
  if (input.kind === "build_book") {
    try {
      parseBuildBookCommand(input);
      return true;
    } catch {
      return false;
    }
  }
  const baseKeys = [
    "attempt",
    "createdAtMs",
    "jobId",
    "kind",
    "stagingRelativePath",
  ] as const;
  if (!(
    isOpaqueId("job", String(input.jobId)) &&
    userJobKinds.includes(input.kind as (typeof userJobKinds)[number]) &&
    Number.isSafeInteger(input.attempt) &&
    Number(input.attempt) >= 1 &&
    Number.isSafeInteger(input.createdAtMs) &&
    Number(input.createdAtMs) >= 0 &&
    input.stagingRelativePath === `staging/${input.jobId}`
  )) {
    return false;
  }
  if (input.kind === "purge_book") {
    return (
      exactKeys(input, [...baseKeys, "bookId"]) &&
      isNullablePositiveInteger(input.bookId) &&
      input.bookId !== null
    );
  }
  if (input.kind === "analyze_import") {
    return (
      exactKeys(input, [...baseKeys, "importId", "importUploadRelativePath"]) &&
      typeof input.importId === "string" &&
      isOpaqueId("import", input.importId) &&
      input.importUploadRelativePath ===
        `tmp/uploads/${input.importId}/original.zip`
    );
  }
  if (input.kind === "prepare_draft") {
    return (
      exactKeys(input, [
        ...baseKeys,
        "bookId",
        "importId",
        "importUploadRelativePath",
        "sourceRelativePath",
      ]) &&
      isNullablePositiveInteger(input.bookId) &&
      input.bookId !== null &&
      typeof input.importId === "string" &&
      isOpaqueId("import", input.importId) &&
      input.importUploadRelativePath ===
        "tmp/uploads/" + input.importId + "/original.zip" &&
      typeof input.sourceRelativePath === "string" &&
      input.sourceRelativePath.length > 0 &&
      input.sourceRelativePath.length <= 2048 &&
      !input.sourceRelativePath.includes("\\") &&
      !input.sourceRelativePath.includes("\0") &&
      input.sourceRelativePath
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== "..") &&
      /(?:^|_)content_list_v2\.json$/iu.test(
        input.sourceRelativePath.split("/").at(-1) ?? "",
      )
    );
  }
  return false;
}

export function isCancelJobMessage(value: unknown): value is CancelJobMessage {
  return (
    isRecord(value) &&
    value.type === "cancel" &&
    value.protocolVersion === jobChildProtocolVersion &&
    typeof value.jobId === "string" &&
    isOpaqueId("job", value.jobId)
  );
}

export function isChildToParentMessage(
  value: unknown,
): value is ChildToParentMessage {
  if (
    !isRecord(value) ||
    value.protocolVersion !== jobChildProtocolVersion ||
    typeof value.jobId !== "string" ||
    !isOpaqueId("job", value.jobId)
  ) {
    return false;
  }
  if (value.type === "progress") {
    return (
      typeof value.phase === "string" &&
      isKnownJobPhase(value.phase) &&
      isJobProgress(value.progress)
    );
  }
  if (value.type !== "result" || typeof value.ok !== "boolean") return false;
  if (value.result !== undefined && !isSafeScalarRecord(value.result)) {
    return false;
  }
  if (
    value.safeErrorCode !== undefined &&
    (typeof value.safeErrorCode !== "string" ||
      !/^[A-Z][A-Z0-9_]{2,79}$/.test(value.safeErrorCode))
  ) {
    return false;
  }
  return true;
}
