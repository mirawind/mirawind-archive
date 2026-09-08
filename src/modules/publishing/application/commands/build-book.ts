import { isOpaqueId } from "@/domain/ids";

export const buildIdentities = Object.freeze({
  compiler: "compiler-v8",
  preview: "draft-preview-v8",
  reader: "mirawind-reader-v5-tailwind-4.3.3",
  renderer: "semantic-html-v8-katex-0.18.1",
} as const);
export const buildPhases = Object.freeze([
  "compile_book",
  "render_pages",
  "build_search",
  "finalize_build",
] as const);
export type BuildPhase = (typeof buildPhases)[number];
export interface BuildStageUpdate {
  readonly completed: number;
  readonly phase: BuildPhase;
  readonly total: number | null;
  readonly unit: "items" | "pages" | "steps";
}
export interface BuildBookCommand {
  readonly reuse: { readonly id: string; readonly markerSha256: string } | null;
  readonly bookId: number;
  readonly capturedCurrentVersionId: string | null;
  readonly compilerIdentity: typeof buildIdentities.compiler;
  readonly inputRelativePath: string;
  readonly documentSha256: string;
  readonly sourceUpdatedAt: number;
  readonly jobId: string;
  readonly kind: "build_book";
  readonly previewIdentity: typeof buildIdentities.preview;
  readonly readerIdentity: typeof buildIdentities.reader;
  readonly rendererIdentity: typeof buildIdentities.renderer;
  readonly importId: string;
  readonly resourceRootRelativePath: string;
  readonly versionId: string;
}
export interface BuildArtifact {
  readonly artifactRootRelativePath: string;
  readonly blockingDiagnosticCount: number;
  readonly compilerIdentity: typeof buildIdentities.compiler;
  readonly diagnosticCount: number;
  readonly kind: "book_build_artifact";
  readonly manifestSha256: string;
  readonly pageCount: number;
  readonly previewIdentity: typeof buildIdentities.preview;
  readonly readerIdentity: typeof buildIdentities.reader;
  readonly rendererIdentity: typeof buildIdentities.renderer;
  readonly resourceCount: number;
  readonly searchRowCount: number;
  readonly semanticDigest: string;
  readonly versionId: string;
  readonly versionMarkerSha256: string;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("BUILD_PROTOCOL_INVALID");
  return value as Record<string, unknown>;
}
function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function count(value: unknown, maximum = 1_000_000): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
  );
}
export function parseBuildBookCommand(value: unknown): BuildBookCommand {
  const input = record(value);
  const keys = [
    "reuse",
    "bookId",
    "capturedCurrentVersionId",
    "compilerIdentity",
    "documentSha256",
    "inputRelativePath",
    "sourceUpdatedAt",
    "jobId",
    "kind",
    "previewIdentity",
    "readerIdentity",
    "rendererIdentity",
    "importId",
    "resourceRootRelativePath",
    "versionId",
  ];
  if (
    !exactKeys(input, keys) ||
    (input.reuse !== null &&
      (!input.reuse ||
        typeof input.reuse !== "object" ||
        Array.isArray(input.reuse) ||
        !exactKeys(input.reuse as Record<string, unknown>, [
          "id",
          "markerSha256",
        ]) ||
        !isOpaqueId(
          "version",
          String((input.reuse as Record<string, unknown>).id),
        ) ||
        !/^[a-f0-9]{64}$/.test(
          String((input.reuse as Record<string, unknown>).markerSha256),
        ))) ||
    input.kind !== "build_book" ||
    !count(input.bookId, Number.MAX_SAFE_INTEGER) ||
    Number(input.bookId) < 1 ||
    !count(input.sourceUpdatedAt, 8_640_000_000_000_000) ||
    typeof input.documentSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(input.documentSha256) ||
    !isOpaqueId("job", String(input.jobId)) ||
    !isOpaqueId("import", String(input.importId)) ||
    !isOpaqueId("version", String(input.versionId)) ||
    (input.capturedCurrentVersionId !== null &&
      !isOpaqueId("version", String(input.capturedCurrentVersionId))) ||
    input.compilerIdentity !== buildIdentities.compiler ||
    input.rendererIdentity !== buildIdentities.renderer ||
    input.previewIdentity !== buildIdentities.preview ||
    input.readerIdentity !== buildIdentities.reader ||
    input.resourceRootRelativePath !== "books/" + input.bookId ||
    input.inputRelativePath !== "staging/" + input.jobId + "/input/book.json"
  ) {
    throw new TypeError("BUILD_COMMAND_INVALID");
  }
  return Object.freeze(value as BuildBookCommand);
}
export function parseBuildArtifact(
  value: unknown,
  command: BuildBookCommand,
): BuildArtifact {
  const input = record(value);
  const keys = [
    "artifactRootRelativePath",
    "blockingDiagnosticCount",
    "compilerIdentity",
    "diagnosticCount",
    "kind",
    "manifestSha256",
    "pageCount",
    "previewIdentity",
    "readerIdentity",
    "rendererIdentity",
    "resourceCount",
    "searchRowCount",
    "semanticDigest",
    "versionId",
    "versionMarkerSha256",
  ];
  if (
    !exactKeys(input, keys) ||
    input.kind !== "book_build_artifact" ||
    input.versionId !== command.versionId ||
    input.compilerIdentity !== command.compilerIdentity ||
    input.rendererIdentity !== command.rendererIdentity ||
    input.previewIdentity !== command.previewIdentity ||
    input.readerIdentity !== command.readerIdentity ||
    input.artifactRootRelativePath !==
      "books/" + command.bookId + "/builds/" + command.versionId ||
    ![
      "blockingDiagnosticCount",
      "diagnosticCount",
      "pageCount",
      "resourceCount",
      "searchRowCount",
    ].every((key) => count(input[key])) ||
    Number(input.pageCount) < 1 ||
    Number(input.pageCount) > 20000 ||
    Number(input.resourceCount) > 20000 ||
    Number(input.diagnosticCount) > 10000 ||
    Number(input.blockingDiagnosticCount) > Number(input.diagnosticCount) ||
    !["manifestSha256", "semanticDigest", "versionMarkerSha256"].every(
      (key) =>
        typeof input[key] === "string" && /^[a-f0-9]{64}$/u.test(input[key]),
    )
  ) {
    throw new TypeError("BUILD_ARTIFACT_INVALID");
  }
  return Object.freeze(value as BuildArtifact);
}
