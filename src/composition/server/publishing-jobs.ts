import type Database from "better-sqlite3";
import { cancelBookDeletion, retryBookDeletion } from "../book-deletion";
import { BuildRepository } from "@/modules/publishing/adapters/sqlite/builds";
import { DraftRepository } from "@/modules/publishing/adapters/sqlite/drafts";
import { ImportRepository } from "@/modules/publishing/adapters/sqlite/imports";
import {
  serializeJobStatus,
  type JobSubject,
} from "@/modules/publishing/adapters/sqlite/job-status";
import { JobRepository } from "@/modules/publishing/adapters/sqlite/jobs";

export function createPublishingJobServer(database: Database.Database) {
  const drafts = new DraftRepository(database),
    builds = new BuildRepository(database),
    imports = new ImportRepository(database),
    jobs = new JobRepository(database);
  const subject = (
    job: NonNullable<ReturnType<JobRepository["get"]>>,
  ): JobSubject => {
    const book = job.bookId === null ? null : drafts.findBook(job.bookId);
    if (book) return { kind: "book", label: book.title };
    const imported = job.importId === null ? null : imports.find(job.importId);
    return imported
      ? { kind: "import", label: imported.originalName }
      : { kind: "system", label: "系统维护" };
  };
  return Object.freeze({
    cancelJob(jobId: string, nowMs: number) {
      const job = jobs.get(jobId);
      return job?.kind === "purge_book"
        ? cancelBookDeletion(database, job, nowMs)
        : jobs.requestCancellation(jobId, nowMs);
    },
    getJob: jobs.get.bind(jobs),
    listRecentJobs: jobs.listRecent.bind(jobs),
    retryJob(
      jobId: string,
      input: {
        automatic: boolean;
        nowMs: number;
        idempotency?: { key: string; operation: string };
      },
    ) {
      const job = jobs.get(jobId);
      if (job?.kind === "purge_book")
        return retryBookDeletion({ ...input, database, jobId });
      if (job?.kind === "build_book") return builds.retry(job, input);
      return jobs.retry(jobId, input);
    },
    serializeJobStatus: (job: NonNullable<ReturnType<JobRepository["get"]>>) =>
      serializeJobStatus(job, subject(job)),
  });
}
