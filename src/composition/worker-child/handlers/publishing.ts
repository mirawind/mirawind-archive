import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import type {
  AnalyzeImportCommand,
  PrepareDraftCommand,
} from "@/entrypoints/worker/protocol";
import type { BuildBookCommand } from "@/modules/publishing/application/publishing-api";
import { handleBuildBook } from "@/entrypoints/worker/handlers/build-book";
import { analyzeImport } from "@/modules/publishing/adapters/worker/analyze-import";
import { buildBookVersion } from "@/modules/publishing/adapters/filesystem/build-book-version";
import { prepareDraft } from "@/modules/publishing/adapters/worker/prepare-draft";
import type { SafeDiagnostic } from "@/domain/errors";
import { createStorageLayout } from "@/platform/filesystem/storage-layout";
import { resolveContainedPath } from "@/platform/filesystem/contained-path";
import {
  stepProgress,
  type WorkerChildContext,
  type WorkerChildOutcome,
} from "../job-handler";

export async function buildBookHandler(
  command: BuildBookCommand,
  context: WorkerChildContext,
): Promise<WorkerChildOutcome> {
  const layout = await createStorageLayout(context.root);
  const snapshotPath = await resolveContainedPath(
    context.root,
    command.inputRelativePath,
  );
  const analysis = JSON.parse(
    await readFile(resolve(dirname(snapshotPath), "analysis.json"), "utf8"),
  ) as { diagnostics: readonly SafeDiagnostic[] };
  const artifact = await handleBuildBook({
    command,
    execute: ({ command: captured, onStage, signal }) =>
      buildBookVersion({
        command: captured,
        createdAtMs: Date.now(),
        layout,
        onStage,
        preparationDiagnostics: analysis.diagnostics,
        ...(signal ? { signal } : {}),
      }),
    onProgress(progress) {
      context.reportProgress(progress.phase, progress.progress);
    },
    signal: context.signal,
  });
  return Object.freeze({ ok: true, result: Object.freeze({ ...artifact }) });
}

export async function analyzeImportHandler(
  command: AnalyzeImportCommand,
  context: WorkerChildContext,
): Promise<WorkerChildOutcome> {
  const stagingDirectory = await resolveContainedPath(
    context.root,
    command.stagingRelativePath,
  );
  const archivePath = await resolveContainedPath(
    context.root,
    command.importUploadRelativePath,
  );
  const result = await analyzeImport({
    archivePath,
    importId: command.importId,
    onPhase(phase, completed, total) {
      context.reportProgress(phase, stepProgress(completed, total));
    },
    sealedExtractionDirectory: resolve(
      dirname(archivePath),
      "sealed-extraction",
    ),
    signal: context.signal,
    stagingDirectory,
  });
  return Object.freeze({
    ok: true,
    result: Object.freeze({
      analysisResultRelativePath: relative(context.root, result.artifactPath)
        .split(sep)
        .join("/"),
      documents: result.artifact.document ? 1 : 0,
      decision: result.artifact.decision,
      entries: result.entries,
      files: result.files,
      totalUncompressedBytes: result.totalUncompressedBytes,
    }),
  });
}

export async function prepareDraftHandler(
  command: PrepareDraftCommand,
  context: WorkerChildContext,
): Promise<WorkerChildOutcome> {
  const stagingDirectory = await resolveContainedPath(
    context.root,
    command.stagingRelativePath,
  );
  const archivePath = await resolveContainedPath(
    context.root,
    command.importUploadRelativePath,
  );
  const result = await prepareDraft({
    archivePath,
    bookId: command.bookId,
    importId: command.importId,
    onPhase(phase, completed, total) {
      context.reportProgress(phase, stepProgress(completed, total));
    },
    sealedExtractionDirectory: resolve(
      dirname(archivePath),
      "sealed-extraction",
    ),
    sourcePath: command.sourceRelativePath,
    signal: context.signal,
    stagingDirectory,
  });
  return Object.freeze({
    ok: true,
    result: Object.freeze({
      preparedDraftRelativePath: relative(context.root, result.artifactPath)
        .split(sep)
        .join("/"),
    }),
  });
}
