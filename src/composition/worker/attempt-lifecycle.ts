import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type Database from "better-sqlite3";

import {
  completeBookDeletionFailure,
  completeBookDeletionInterruption,
  recordExpiredBookDeletion,
  retryBookDeletion,
} from "../book-deletion";
import { BuildRepository } from "@/modules/publishing/adapters/sqlite/builds";
import { ImportRepository } from "@/modules/publishing/adapters/sqlite/imports";
import {
  JobRepository,
  type JobErrorClass,
  type JobRecord,
} from "@/modules/publishing/adapters/sqlite/jobs";
import type { StorageLayout } from "@/platform/filesystem/storage-layout";
import { resolveContainedPath } from "@/platform/filesystem/contained-path";
import { withImmediateTransaction } from "@/platform/sqlite/immediate-transaction";

export async function cancelImportJob(input: {
  readonly imports: ImportRepository;
  readonly job: JobRecord;
  readonly layout: StorageLayout;
  readonly nowMs: number;
}): Promise<void> {
  if (
    !input.job.importId ||
    (input.job.kind !== "analyze_import" && input.job.kind !== "prepare_draft")
  ) {
    return;
  }
  const imported = input.imports.require(input.job.importId);
  if (["uploaded", "analyzing", "preparing"].includes(imported.state)) {
    input.imports.cancel(imported.id, input.nowMs);
  }
  await rm(resolve(input.layout.root, "staging", input.job.id), {
    force: true,
    recursive: true,
  });
  if (input.job.kind === "analyze_import") {
    const archivePath = await resolveContainedPath(
      input.layout.root,
      imported.uploadRelativePath,
    );
    await rm(resolve(dirname(archivePath), "sealed-extraction"), {
      force: true,
      recursive: true,
    });
  }
}

export function completeJobFailure(input: {
  readonly builds: BuildRepository;
  readonly database: Database.Database;
  readonly errorClass: JobErrorClass;
  readonly errorCode: string;
  readonly job: JobRecord;
  readonly leaseOwner: string;
  readonly nowMs: number;
  readonly repository: JobRepository;
}): JobRecord {
  if (input.job.kind === "purge_book")
    return completeBookDeletionFailure(input);
  if (input.job.kind !== "build_book") {
    return input.repository.completeFailure({
      errorClass: input.errorClass,
      errorCode: input.errorCode,
      jobId: input.job.id,
      leaseOwner: input.leaseOwner,
      nowMs: input.nowMs,
    });
  }
  return withImmediateTransaction(input.database, () => {
    const completed = input.repository.completeFailure({
      errorClass: input.errorClass,
      errorCode: input.errorCode,
      jobId: input.job.id,
      leaseOwner: input.leaseOwner,
      nowMs: input.nowMs,
    });
    return completed;
  });
}

export function completeJobInterruption(input: {
  readonly builds: BuildRepository;
  readonly database: Database.Database;
  readonly errorCode: string;
  readonly job: JobRecord;
  readonly leaseOwner: string;
  readonly nowMs: number;
  readonly repository: JobRepository;
}): JobRecord {
  if (input.job.kind === "purge_book") {
    return completeBookDeletionInterruption(input);
  }
  if (input.job.kind !== "build_book") {
    return input.repository.completeInterruption({
      errorCode: input.errorCode,
      jobId: input.job.id,
      leaseOwner: input.leaseOwner,
      nowMs: input.nowMs,
    });
  }
  return withImmediateTransaction(input.database, () => {
    const completed = input.repository.completeInterruption({
      errorCode: input.errorCode,
      jobId: input.job.id,
      leaseOwner: input.leaseOwner,
      nowMs: input.nowMs,
    });
    return completed;
  });
}

export function recordExpiredJobLifecycle(input: {
  readonly builds: BuildRepository;
  readonly database: Database.Database;
  readonly job: JobRecord;
  readonly nowMs: number;
}): void {
  recordExpiredBookDeletion(input.database, input.job, input.nowMs);
}

export function retryJobAttempt(input: {
  readonly automatic: boolean;
  readonly builds: BuildRepository;
  readonly database: Database.Database;
  readonly job: JobRecord;
  readonly jobs: JobRepository;
  readonly nowMs: number;
}): JobRecord {
  if (input.job.kind === "purge_book") {
    return retryBookDeletion({
      automatic: input.automatic,
      database: input.database,
      jobId: input.job.id,
      nowMs: input.nowMs,
    });
  }
  if (input.job.kind === "build_book") {
    return input.builds.retry(input.job, {
      automatic: input.automatic,
      nowMs: input.nowMs,
    });
  }
  return withImmediateTransaction(input.database, () => {
    const retry = input.jobs.retry(input.job.id, {
      automatic: input.automatic,
      nowMs: input.nowMs,
    });
    return retry;
  });
}
