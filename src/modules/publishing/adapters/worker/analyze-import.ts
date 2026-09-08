import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { extractZipFile } from "../filesystem/extract-archive";
import {
  discoverMineruCandidates,
  type CandidateDiscovery,
  type MineruCandidate,
} from "../filesystem/discover-mineru-candidates";
import { sealExtractedDirectory } from "../filesystem/sealed-extraction";
import { ImportRepository, type ImportRecord } from "../sqlite/imports";
import { atomicWriteFile } from "@/platform/filesystem/atomic-file";
import {
  profilePipelineStage,
  recordPipelineProfileMetrics,
} from "@/observability/pipeline-profile";

const importAnalysisVersion = "mineru-content-candidate-v2";
const analysisArtifactFilename = "analysis-result.json";

export interface AnalyzeImportArtifact {
  readonly candidates: readonly MineruCandidate[];
  readonly decision: CandidateDiscovery["decision"];
  readonly reason: CandidateDiscovery["reason"];
  readonly selectedCandidateId: string | null;
  readonly version: typeof importAnalysisVersion;
}

export interface AnalyzeImportResult {
  readonly artifact: AnalyzeImportArtifact;
  readonly artifactPath: string;
  readonly entries: number;
  readonly files: number;
  readonly totalUncompressedBytes: number;
}

function rejectionCode(reason: CandidateDiscovery["reason"]): string {
  if (reason === "multiple-book-bundles") return "IMPORT_MULTIPLE_BOOKS";
  if (reason === "document-too-large") return "CONTENT_FILE_LIMIT_EXCEEDED";
  return "IMPORT_MINERU_JSON_MISSING";
}

export async function analyzeImport(input: {
  readonly archivePath: string;
  readonly importId?: string;
  readonly onPhase?: (
    phase: "identify_document" | "extract_archive",
    completed: number,
    total: number,
  ) => void;
  readonly sealedExtractionDirectory?: string;
  readonly signal?: AbortSignal;
  readonly stagingDirectory: string;
}): Promise<AnalyzeImportResult> {
  if (Boolean(input.importId) !== Boolean(input.sealedExtractionDirectory)) {
    throw new Error("SEALED_EXTRACTION_INPUT_INVALID");
  }
  const stagingDirectory = resolve(input.stagingDirectory);
  const extractedDirectory = resolve(stagingDirectory, "extracted");
  const artifactPath = resolve(stagingDirectory, analysisArtifactFilename);
  try {
    await mkdir(dirname(stagingDirectory), { mode: 0o700, recursive: true });
    await mkdir(stagingDirectory, { mode: 0o700, recursive: false });
    input.onPhase?.("extract_archive", 0, 2);
    const extracted = await profilePipelineStage("archive_extract", () =>
      extractZipFile({
        archivePath: input.archivePath,
        destination: extractedDirectory,
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    );
    recordPipelineProfileMetrics({
      archive_entries: extracted.entries,
      archive_files: extracted.files,
      archive_uncompressed_bytes: extracted.totalUncompressedBytes,
    });
    input.onPhase?.("identify_document", 1, 2);
    const discovered = await profilePipelineStage("candidate_discovery", () =>
      discoverMineruCandidates(extractedDirectory),
    );
    recordPipelineProfileMetrics({
      content_candidates: discovered.candidates.length,
    });
    input.onPhase?.("identify_document", 2, 2);
    const artifact: AnalyzeImportArtifact = Object.freeze({
      candidates: discovered.candidates,
      decision: discovered.decision,
      reason: discovered.reason,
      selectedCandidateId: discovered.selectedCandidateId,
      version: importAnalysisVersion,
    });
    await profilePipelineStage("artifact_write", () =>
      atomicWriteFile(artifactPath, `${JSON.stringify(artifact)}\n`, {
        mode: 0o600,
      }),
    );
    if (artifact.decision === "reject") {
      await rm(extractedDirectory, { force: true, recursive: true });
    } else if (input.importId && input.sealedExtractionDirectory) {
      await sealExtractedDirectory({
        extractedRoot: extractedDirectory,
        extraction: extracted,
        importId: input.importId,
        sealedDirectory: input.sealedExtractionDirectory,
      });
    }
    return Object.freeze({
      artifact,
      artifactPath,
      entries: extracted.entries,
      files: extracted.files,
      totalUncompressedBytes: extracted.totalUncompressedBytes,
    });
  } catch (error) {
    await rm(stagingDirectory, { force: true, recursive: true });
    throw error;
  }
}

function isCandidate(value: unknown): value is MineruCandidate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.normalizedPath === "string" &&
    typeof candidate.byteSize === "number" &&
    candidate.confidence === "high" &&
    typeof candidate.score === "number" &&
    (typeof candidate.firstHeading === "string" ||
      candidate.firstHeading === null) &&
    typeof candidate.referencedResources === "number" &&
    Array.isArray(candidate.companionFiles) &&
    Array.isArray(candidate.diagnostics)
  );
}

export async function readAnalyzeImportArtifact(
  artifactPath: string,
): Promise<AnalyzeImportArtifact> {
  if ((await stat(artifactPath)).size > 16 * 1024 * 1024) {
    throw new Error("IMPORT_ANALYSIS_ARTIFACT_INVALID");
  }
  const parsed: unknown = JSON.parse(await readFile(artifactPath, "utf8"));
  if (!parsed || typeof parsed !== "object") {
    throw new Error("IMPORT_ANALYSIS_ARTIFACT_INVALID");
  }
  const artifact = parsed as Record<string, unknown>;
  if (
    artifact.version !== importAnalysisVersion ||
    !Array.isArray(artifact.candidates) ||
    !artifact.candidates.every(isCandidate) ||
    !["automatic", "reject"].includes(String(artifact.decision)) ||
    ![
      "mineru-v2",
      "multiple-book-bundles",
      "no-mineru-json",
      "document-too-large",
    ].includes(String(artifact.reason)) ||
    (typeof artifact.selectedCandidateId !== "string" &&
      artifact.selectedCandidateId !== null)
  ) {
    throw new Error("IMPORT_ANALYSIS_ARTIFACT_INVALID");
  }
  const result = parsed as AnalyzeImportArtifact;
  const selectedExists =
    result.selectedCandidateId === null ||
    result.candidates.some(
      (candidate) => candidate.id === result.selectedCandidateId,
    );
  if (
    !selectedExists ||
    (result.decision === "automatic" && result.selectedCandidateId === null) ||
    (result.decision === "reject" && result.selectedCandidateId !== null)
  ) {
    throw new Error("IMPORT_ANALYSIS_ARTIFACT_INVALID");
  }
  return result;
}

export function persistAnalyzeImportArtifact(input: {
  readonly artifact: AnalyzeImportArtifact;
  readonly importId: string;
  readonly nowMs: number;
  readonly repository: ImportRepository;
}): ImportRecord {
  if (input.artifact.decision === "reject") {
    return input.repository.saveRejectedCandidates({
      candidates: input.artifact.candidates,
      errorCode: rejectionCode(input.artifact.reason),
      importId: input.importId,
      nowMs: input.nowMs,
    });
  }
  return input.repository.saveCandidates({
    candidates: input.artifact.candidates,
    importId: input.importId,
    nextState: "preparing",
    nowMs: input.nowMs,
    selectedCandidateId:
      input.artifact.decision === "automatic"
        ? input.artifact.selectedCandidateId
        : null,
  });
}
