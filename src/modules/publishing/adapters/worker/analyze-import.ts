import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { extractZipFile } from "../filesystem/extract-archive";
import {
  findMineruDocument,
  type MineruDocumentSelection,
} from "../filesystem/find-mineru-document";
import { sealExtractedDirectory } from "../filesystem/sealed-extraction";
import { ImportRepository, type ImportRecord } from "../sqlite/imports";
import { atomicWriteFile } from "@/platform/filesystem/atomic-file";
import {
  profilePipelineStage,
  recordPipelineProfileMetrics,
} from "@/observability/pipeline-profile";

const importAnalysisVersion = "mineru-document-v1";
const analysisArtifactFilename = "analysis-result.json";

export interface AnalyzeImportArtifact {
  readonly document: MineruDocumentSelection["document"];
  readonly decision: MineruDocumentSelection["decision"];
  readonly reason: MineruDocumentSelection["reason"];
  readonly version: typeof importAnalysisVersion;
}

export interface AnalyzeImportResult {
  readonly artifact: AnalyzeImportArtifact;
  readonly artifactPath: string;
  readonly entries: number;
  readonly files: number;
  readonly totalUncompressedBytes: number;
}

function rejectionCode(reason: MineruDocumentSelection["reason"]): string {
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
      findMineruDocument(extractedDirectory),
    );
    recordPipelineProfileMetrics({
      content_candidates: discovered.document ? 1 : 0,
    });
    input.onPhase?.("identify_document", 2, 2);
    const artifact: AnalyzeImportArtifact = Object.freeze({
      document: discovered.document,
      decision: discovered.decision,
      reason: discovered.reason,
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

export async function readAnalyzeImportArtifact(
  artifactPath: string,
): Promise<AnalyzeImportArtifact> {
  if ((await stat(artifactPath)).size > 65536)
    throw new Error("IMPORT_ANALYSIS_ARTIFACT_INVALID");
  const value = JSON.parse(
    await readFile(artifactPath, "utf8"),
  ) as AnalyzeImportArtifact;
  if (
    value.version !== importAnalysisVersion ||
    !["automatic", "reject"].includes(value.decision) ||
    ![
      "mineru-v2",
      "multiple-book-bundles",
      "no-mineru-json",
      "document-too-large",
    ].includes(value.reason) ||
    (value.decision === "automatic"
      ? !value.document ||
        typeof value.document.path !== "string" ||
        !Number.isSafeInteger(value.document.size)
      : value.document !== null)
  )
    throw new Error("IMPORT_ANALYSIS_ARTIFACT_INVALID");
  return value;
}
export function persistAnalyzeImportArtifact(input: {
  artifact: AnalyzeImportArtifact;
  importId: string;
  nowMs: number;
  repository: ImportRepository;
}): ImportRecord {
  return input.artifact.document && input.artifact.decision === "automatic"
    ? input.repository.selectDocument({
        importId: input.importId,
        path: input.artifact.document.path,
        nowMs: input.nowMs,
      })
    : input.repository.reject(
        input.importId,
        rejectionCode(input.artifact.reason),
        input.nowMs,
      );
}
