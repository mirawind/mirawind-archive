import { isOpaqueId } from "./ids";

const safeApplicationErrorBrand = Symbol.for("mirawind.SafeApplicationError");

export class SafeApplicationError extends Error {
  readonly [safeApplicationErrorBrand] = true;

  // Vite can reload this class while existing request handlers still reference it.
  static override [Symbol.hasInstance](value: unknown): boolean {
    return (
      typeof value === "object" &&
      value !== null &&
      Object.getOwnPropertyDescriptor(value, safeApplicationErrorBrand)
        ?.value === true
    );
  }

  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SafeApplicationError";
  }
}

export interface DiagnosticTarget {
  readonly blockId: string;
  readonly kind: "edit_block" | "select_structure";
  readonly pageId: number;
}

export function safeErrorCode(error: unknown): string {
  return error instanceof SafeApplicationError
    ? error.code
    : "INTERNAL_SERVER_ERROR";
}

export interface SafeDiagnostic {
  readonly blockId?: string;
  readonly code: string;
  readonly confidence?: "high" | "low" | "medium";
  readonly evidence?: readonly string[];
  readonly location?: {
    readonly blockId?: string;
    readonly pageIndex?: number;
    readonly regionId?: string;
  };
  readonly message: string;
  readonly path?: string;
  readonly phase?:
    | "contents"
    | "matching"
    | "ocr"
    | "selection"
    | "splitting"
    | "structure"
    | "typography";
  readonly severity?: "error" | "info" | "warning";
  readonly targets?: readonly DiagnosticTarget[];
}

export function createSafeDiagnostic(input: SafeDiagnostic): SafeDiagnostic {
  if (!/^[A-Z][A-Z0-9_]{2,79}$/.test(input.code)) {
    throw new TypeError("Diagnostic code is invalid");
  }
  const confidence = ["high", "low", "medium"].includes(
    String(input.confidence),
  )
    ? input.confidence
    : undefined;
  const phase = [
    "contents",
    "matching",
    "ocr",
    "selection",
    "splitting",
    "structure",
    "typography",
  ].includes(String(input.phase))
    ? input.phase
    : undefined;
  const targets: DiagnosticTarget[] = [];
  const seenTargets = new Set<string>();
  for (const target of input.targets ?? []) {
    if (target.kind !== "edit_block" && target.kind !== "select_structure") {
      continue;
    }
    if (
      isOpaqueId("block", target.blockId) &&
      Number.isSafeInteger(target.pageId) &&
      target.pageId > 0
    ) {
      const key = `${target.kind}:${target.blockId}:${target.pageId}`;
      if (seenTargets.has(key)) continue;
      seenTargets.add(key);
      targets.push(
        Object.freeze({
          blockId: target.blockId,
          kind: target.kind,
          pageId: target.pageId,
        }),
      );
    }
  }
  const location = input.location;
  const safeLocation = location
    ? Object.freeze({
        ...(location.blockId && isOpaqueId("block", location.blockId)
          ? { blockId: location.blockId }
          : {}),
        ...(Number.isSafeInteger(location.pageIndex) &&
        Number(location.pageIndex) >= 0
          ? { pageIndex: Number(location.pageIndex) }
          : {}),
        ...(location.regionId && isOpaqueId("region", location.regionId)
          ? { regionId: location.regionId }
          : {}),
      })
    : undefined;
  return Object.freeze({
    ...(input.blockId && isOpaqueId("block", input.blockId)
      ? { blockId: input.blockId }
      : {}),
    code: input.code,
    ...(confidence ? { confidence } : {}),
    ...(input.evidence
      ? {
          evidence: Object.freeze(
            input.evidence
              .filter((value) => typeof value === "string")
              .slice(0, 10)
              .map((value) => value.slice(0, 200)),
          ),
        }
      : {}),
    ...(safeLocation && Object.keys(safeLocation).length > 0
      ? { location: safeLocation }
      : {}),
    message: input.message.slice(0, 500),
    ...(input.path ? { path: input.path.slice(0, 500) } : {}),
    ...(phase ? { phase } : {}),
    ...(input.severity ? { severity: input.severity } : {}),
    ...(targets.length > 0
      ? { targets: Object.freeze(targets.slice(0, 4)) }
      : {}),
  });
}
