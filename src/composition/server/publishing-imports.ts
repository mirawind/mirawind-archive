import type Database from "better-sqlite3";

import { ImportUploadService } from "@/modules/publishing/adapters/filesystem/import-upload";
import { ImportRepository } from "@/modules/publishing/adapters/sqlite/imports";
import { JobRepository } from "@/modules/publishing/adapters/sqlite/jobs";
import type { StorageLayout } from "@/platform/filesystem/storage-layout";

export function createPublishingImportServer(database: Database.Database) {
  const imports = new ImportRepository(database);
  const jobs = new JobRepository(database);
  return Object.freeze({
    findImport: imports.find.bind(imports),
    findJobByIdempotency: jobs.findByIdempotency.bind(jobs),
    latestJobForImport: jobs.latestForImport.bind(jobs),
    requireImport: imports.require.bind(imports),
    storeImport: (layout: StorageLayout) =>
      new ImportUploadService(database, layout),
  });
}
