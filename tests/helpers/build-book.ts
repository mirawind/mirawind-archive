import type Database from "better-sqlite3";
import type { StorageLayout } from "@/platform/filesystem/storage-layout";
import { captureFrozenJobInput } from "@/composition/worker/capture-frozen-input";
import { buildBookHandler } from "@/composition/worker-child/handlers/publishing";
import { BuildRepository } from "@/modules/publishing/adapters/sqlite/builds";
import { ImportRepository } from "@/modules/publishing/adapters/sqlite/imports";
import { JobRepository } from "@/modules/publishing/adapters/sqlite/jobs";
import { BuildRegistrationRepository } from "@/modules/publishing/adapters/sqlite/build-registration";
import { BookPresentationRepository } from "@/modules/catalog/adapters/sqlite/book-presentations";
import { finalizeBuild } from "@/modules/publishing/application/commands/finalize-build";

export async function buildSavedBook(
  database: Database.Database,
  layout: StorageLayout,
) {
  const job = new JobRepository(database).claimNext({
    leaseOwner: "test",
    nowMs: Date.now() + 2000,
  });
  if (!job) throw new Error("BUILD_JOB_MISSING");
  const command = await captureFrozenJobInput({
    job,
    database,
    layout,
    builds: new BuildRepository(database),
    imports: new ImportRepository(database),
  });
  if (command.kind !== "build_book") throw new Error("BUILD_JOB_INVALID");
  const result = await buildBookHandler(command, {
    root: layout.root,
    signal: new AbortController().signal,
    reportProgress() {},
  });
  if (!result.ok) throw new Error("BUILD_FAILED");
  return finalizeBuild({
    artifact: result.result,
    command,
    leaseOwner: "test",
    nowMs: Date.now(),
    registration: new BuildRegistrationRepository(
      database,
      layout,
      new BookPresentationRepository(database),
    ),
  });
}
