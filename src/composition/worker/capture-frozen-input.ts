import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type Database from "better-sqlite3";
import { BuildRepository } from "@/modules/publishing/adapters/sqlite/builds";
import { DocumentRepository } from "@/modules/publishing/adapters/sqlite/documents";
import { ImportRepository } from "@/modules/publishing/adapters/sqlite/imports";
import type { UserJobRecord } from "@/modules/publishing/adapters/sqlite/jobs";
import type { FrozenJobInput } from "@/entrypoints/worker/protocol";
import type { StorageLayout } from "@/platform/filesystem/storage-layout";
import { atomicWriteFile } from "@/platform/filesystem/atomic-file";

export async function captureFrozenJobInput(input: {
  job: UserJobRecord;
  builds: BuildRepository;
  imports: ImportRepository;
  database: Database.Database;
  layout: StorageLayout;
}): Promise<FrozenJobInput> {
  const job = input.job;
  const common = {
    attempt: job.attempt,
    createdAtMs: job.createdAtMs,
    jobId: job.id,
    stagingRelativePath: "staging/" + job.id,
  };
  if (job.kind === "purge_book") {
    if (job.bookId === null) throw new Error("PURGE_BOOK_INPUT_INVALID");
    return { ...common, bookId: job.bookId, kind: job.kind };
  }
  if (job.kind === "analyze_import" || job.kind === "prepare_draft") {
    if (!job.importId) throw new Error("IMPORT_JOB_INPUT_INVALID");
    const imported = input.imports.require(job.importId);
    if (job.kind === "analyze_import")
      return {
        ...common,
        kind: job.kind,
        importId: imported.id,
        importUploadRelativePath: imported.uploadRelativePath,
      };
    if (imported.bookId === null || !imported.sourcePath)
      throw new Error("PREPARE_DRAFT_INPUT_INVALID");
    return {
      ...common,
      kind: job.kind,
      bookId: imported.bookId,
      importId: imported.id,
      importUploadRelativePath: imported.uploadRelativePath,
      sourceRelativePath: imported.sourcePath,
    };
  }
  if (!job.versionId) throw new Error("BUILD_INPUT_INVALID");
  const command = input.builds.buildCommand(job.versionId);
  const snapshot = new DocumentRepository(input.database).captureBuild(
    command.bookId,
    command.sourceUpdatedAt,
    command.importId,
  );
  // Preserve validated block JSON without materializing the whole tree in the supervisor.
  // The build child validates the complete frozen document before compiling it.
  const { resources, ...header } = snapshot.book;
  const json =
    JSON.stringify(header).slice(0, -1) +
    ',"blocks":[' +
    snapshot.blocks.join(",") +
    '],"resources":' +
    JSON.stringify(resources) +
    "}\n";
  const destination = resolve(input.layout.root, command.inputRelativePath);
  const root = dirname(destination);
  await atomicWriteFile(destination, json, { mode: 0o400 });
  await atomicWriteFile(
    resolve(root, "resources.json"),
    JSON.stringify(snapshot.resources),
    { mode: 0o400 },
  );
  await atomicWriteFile(
    resolve(root, "original.json"),
    JSON.stringify({ import_id: command.importId, files: snapshot.originals }),
    { mode: 0o400 },
  );
  await atomicWriteFile(
    resolve(root, "analysis.json"),
    await readFile(
      resolve(
        input.layout.bookDirectory,
        String(command.bookId),
        "import/analysis.json",
      ),
    ),
    { mode: 0o400 },
  );
  return {
    ...command,
    documentSha256: createHash("sha256").update(json).digest("hex"),
  };
}
