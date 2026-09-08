import { required } from "../../helpers/required";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  JobRepository,
  type JobRecord,
} from "@/modules/publishing/adapters/sqlite/jobs";
import { recoverExpiredJobLeases } from "@/modules/publishing/application/recover-expired-jobs";
import { evaluateJobRetry } from "@/modules/publishing/application/retry-policy";
import { withMigratedTestDatabase } from "../../helpers/database";
import { setupPublicationFixture } from "../../helpers/publication";

function terminalJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    attempt: 1,
    automaticRetryCount: 0,
    bookId: 42,
    capturedSourceUpdatedAt: 1000,
    capturedCurrentVersionId: null,
    capturedInputPath: null,
    createdAtMs: 1_000,
    errorClass: "content",
    errorCode: "CONTENT_INVALID",
    errorDetail: null,
    finishedAtMs: 2_000,
    heartbeatAtMs: null,
    id: "job_fixture",
    importId: "imp_fixture",
    kind: "analyze_import",
    leaseOwner: null,
    leaseUntilMs: null,
    phase: "failed",
    progress: {
      completed: 0,
      processed_bytes: null,
      total: null,
      unit: "steps",
    },
    cancellationRequestedAtMs: null,
    retryOfJobId: null,
    startedAtMs: 1_100,
    state: "failed",
    versionId: null,
    ...overrides,
  };
}

describe("job retry policy", () => {
  it("allows exactly one automatic retry only for an expired infrastructure lease", () => {
    expect(
      evaluateJobRetry(
        terminalJob({
          errorClass: "infrastructure",
          errorCode: "JOB_LEASE_EXPIRED",
          state: "interrupted",
        }),
        "automatic",
      ),
    ).toEqual({ allowed: true });

    for (const job of [
      terminalJob({
        automaticRetryCount: 1,
        errorClass: "infrastructure",
        errorCode: "JOB_LEASE_EXPIRED",
        state: "interrupted",
      }),
      terminalJob({
        errorClass: "infrastructure",
        errorCode: "WORKER_EXIT",
        state: "interrupted",
      }),
      terminalJob({ errorClass: "timeout", errorCode: "JOB_TIMEOUT" }),
      terminalJob({
        errorClass: "security_limit",
        errorCode: "ARCHIVE_LIMIT",
      }),
    ]) {
      expect(evaluateJobRetry(job, "automatic").allowed).toBe(false);
    }
  });

  it("cleans expired staging and creates at most one infrastructure retry", async () => {
    await withMigratedTestDatabase(async ({ database }, dataRoot) => {
      const repository = new JobRepository(database);
      const original = repository.create({
        kind: "analyze_import",
        nowMs: 1_000,
      });
      repository.claimNext({ leaseOwner: "worker-a", nowMs: 2_000 });
      await mkdir(join(dataRoot.path, "staging", original.id), {
        recursive: true,
      });

      expect(repository.interruptExpired({ nowMs: 62_001 })).toHaveLength(1);
      const firstRecovery = await recoverExpiredJobLeases({
        nowMs: 62_001,
        repository,
        retryJob: (job, nowMs) =>
          repository.retry(job.id, { automatic: true, nowMs }),
        storageRoot: dataRoot.path,
      });
      expect(firstRecovery).toEqual([
        expect.objectContaining({
          interrupted: expect.objectContaining({
            errorCode: "JOB_LEASE_EXPIRED",
            id: original.id,
            state: "interrupted",
          }),
          retry: expect.objectContaining({
            attempt: 2,
            automaticRetryCount: 1,
            retryOfJobId: original.id,
            state: "queued",
          }),
        }),
      ]);
      await expect(
        stat(join(dataRoot.path, "staging", original.id)),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const retry = firstRecovery[0]?.retry;
      if (!retry) throw new Error("Expected automatic retry");
      repository.claimNext({ leaseOwner: "worker-b", nowMs: 63_000 });
      await mkdir(join(dataRoot.path, "staging", retry.id), {
        recursive: true,
      });
      const secondRecovery = await recoverExpiredJobLeases({
        nowMs: 123_001,
        repository,
        retryJob: (job, nowMs) =>
          repository.retry(job.id, { automatic: true, nowMs }),
        storageRoot: dataRoot.path,
      });
      expect(secondRecovery).toEqual([
        expect.objectContaining({
          interrupted: expect.objectContaining({
            automaticRetryCount: 1,
            id: retry.id,
            state: "interrupted",
          }),
          retry: null,
        }),
      ]);
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM jobs").get(),
      ).toEqual({ count: 2 });
    });
  });

  it.each([
    ["content", "CONTENT_INVALID"],
    ["validation", "SCHEMA_INVALID"],
    ["security_limit", "ARCHIVE_LIMIT"],
    ["timeout", "JOB_TIMEOUT"],
    ["infrastructure", "JOB_LEASE_EXPIRED"],
    ["canceled", "JOB_CANCELED"],
  ] as const)(
    "allows an administrator to retry terminal %s failures",
    (errorClass, errorCode) => {
      expect(
        evaluateJobRetry(
          terminalJob({
            automaticRetryCount: errorClass === "infrastructure" ? 1 : 0,
            errorClass,
            errorCode,
            state: errorClass === "infrastructure" ? "interrupted" : "failed",
          }),
          "manual",
        ),
      ).toEqual({ allowed: true });
    },
  );

  it("rejects nonterminal and successful attempts", () => {
    expect(
      evaluateJobRetry(
        terminalJob({
          errorClass: null,
          errorCode: null,
          finishedAtMs: null,
          state: "running",
        }),
        "manual",
      ),
    ).toMatchObject({ allowed: false });
    expect(
      evaluateJobRetry(
        terminalJob({
          errorClass: null,
          errorCode: null,
          state: "succeeded",
        }),
        "manual",
      ),
    ).toMatchObject({ allowed: false });
  });

  it("retries a failed build without introducing a second artifact identity", () =>
    withMigratedTestDatabase(({ database }) => {
      const fixture = setupPublicationFixture(database, {
        registerReady: false,
      });
      const failed = fixture.jobs.completeFailure({
        jobId: fixture.candidateJob.id,
        leaseOwner: "worker:test",
        nowMs: 8,
        errorClass: "timeout",
        errorCode: "JOB_TIMEOUT",
      });
      const retry = fixture.candidates.retry(failed, {
        automatic: false,
        nowMs: 9,
      });
      expect(retry).toMatchObject({
        state: "queued",
        attempt: 2,
        retryOfJobId: failed.id,
      });
      expect(retry.id).not.toBe(failed.id);
      expect(retry.versionId).not.toBe(failed.versionId);
      expect(fixture.candidates.require(required(failed.versionId)).state).toBe(
        "failed",
      );
      expect(fixture.candidates.findCurrent(fixture.book.id)?.id).toBe(
        retry.versionId,
      );
      fixture.jobs.claimNext({ leaseOwner: "test", nowMs: 10 });
      expect(
        fixture.candidates.buildCommand(required(retry.versionId)),
      ).toMatchObject({
        versionId: retry.versionId,
        jobId: retry.id,
        sourceUpdatedAt: fixture.document.updated_at,
      });
    }));
  it("recovers an expired build and preserves its single automatic retry limit", () =>
    withMigratedTestDatabase(async ({ database }, dataRoot) => {
      const fixture = setupPublicationFixture(database, {
        registerReady: false,
      });
      const recovered = await recoverExpiredJobLeases({
        nowMs: 60010,
        repository: fixture.jobs,
        storageRoot: dataRoot.path,
        retryJob: (job, nowMs) =>
          fixture.candidates.retry(job, { automatic: true, nowMs }),
      });
      const retry = recovered[0]?.retry;
      expect(retry).toMatchObject({
        attempt: 2,
        automaticRetryCount: 1,
        state: "queued",
        retryOfJobId: fixture.candidateJob.id,
      });
      expect(fixture.candidates.require(fixture.build.id).state).toBe(
        "interrupted",
      );
      fixture.jobs.claimNext({ leaseOwner: "test", nowMs: 60011 });
      const again = await recoverExpiredJobLeases({
        nowMs: 120012,
        repository: fixture.jobs,
        storageRoot: dataRoot.path,
        retryJob: (job, nowMs) =>
          fixture.candidates.retry(job, { automatic: true, nowMs }),
      });
      expect(again).toHaveLength(1);
      expect(again[0]?.retry).toBeNull();
    }));
});
