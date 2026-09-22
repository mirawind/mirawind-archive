import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { SafeDiagnostic } from "@/domain/errors";

export const draftPreparationVersion = "prepare-draft-v8";
export const preparationArtifactFilename = "prepared-draft.json";
export interface PreparedResource {
  readonly id: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly media_type: string;
  readonly width: number;
  readonly height: number;
}
export interface PreparedDraftArtifact {
  readonly sourcePath: string;
  readonly version: typeof draftPreparationVersion;
  readonly bookId: number;
  readonly sourceUpdatedAt: number;
  readonly title: string;
  readonly documentSha256: string;
  readonly resources: readonly PreparedResource[];
  readonly original: {
    readonly id: string;
    readonly sha256: string;
    readonly size: number;
  };
  readonly diagnostics: readonly SafeDiagnostic[];
}
export function preparedDraftArtifactPath(stagingDirectory: string): string {
  return resolve(stagingDirectory, preparationArtifactFilename);
}
export async function readPreparedDraftArtifact(
  path: string,
): Promise<PreparedDraftArtifact> {
  if ((await stat(path)).size > 16 * 1024 * 1024)
    throw new Error("PREPARED_DRAFT_ARTIFACT_INVALID");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("PREPARED_DRAFT_ARTIFACT_INVALID");
  const artifact = value as PreparedDraftArtifact;
  if (
    artifact.version !== draftPreparationVersion ||
    typeof artifact.sourcePath !== "string" ||
    !Number.isSafeInteger(artifact.bookId) ||
    artifact.bookId < 1 ||
    !Number.isSafeInteger(artifact.sourceUpdatedAt) ||
    artifact.sourceUpdatedAt < 0 ||
    !/^[a-f0-9]{64}$/u.test(artifact.documentSha256) ||
    !Array.isArray(artifact.resources) ||
    artifact.resources.length > 20000 ||
    !Array.isArray(artifact.diagnostics) ||
    typeof artifact.title !== "string" ||
    artifact.title.length < 1 ||
    artifact.title.length > 500 ||
    !artifact.original ||
    !/^file_[A-Za-z0-9_-]{16,80}$/u.test(artifact.original.id) ||
    !/^[a-f0-9]{64}$/u.test(artifact.original.sha256)
  )
    throw new Error("PREPARED_DRAFT_ARTIFACT_INVALID");
  for (const resource of artifact.resources)
    if (
      !/^res_[A-Za-z0-9_-]{16,80}$/u.test(resource.id) ||
      !/^[a-f0-9]{64}$/u.test(resource.sha256) ||
      !Number.isSafeInteger(resource.size) ||
      !Number.isSafeInteger(resource.width) ||
      resource.width < 1 ||
      !Number.isSafeInteger(resource.height) ||
      resource.height < 1 ||
      resource.size < 0 ||
      !resource.path.startsWith("assets/")
    )
      throw new Error("PREPARED_DRAFT_ARTIFACT_INVALID");
  return artifact;
}
