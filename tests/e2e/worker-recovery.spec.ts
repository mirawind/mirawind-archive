import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { createOpaqueId } from "@/domain/ids";
import { ImportRepository } from "@/modules/publishing/adapters/sqlite/imports";
import { openDatabase } from "@/platform/sqlite/connection";
import { JobRepository } from "@/modules/publishing/adapters/sqlite/jobs";

import {
  e2eDataRoot,
  e2eFixtureRoot,
  e2eOrigin,
} from "../helpers/global-setup.js";
import { loginAsAdministrator } from "../helpers/e2e-login.js";
import { startWorkerProcess } from "../helpers/processes.js";

async function waitForProcessExit(pid: number): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          return Boolean(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ESRCH",
          );
        }
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

function pointerSnapshot(): readonly {
  readonly current_version_id: string | null;
  readonly id: number;
}[] {
  const database = openDatabase(resolve(e2eDataRoot, "db", "mirawind.sqlite"), {
    role: "worker",
  });
  try {
    return database
      .prepare(
        `SELECT id, current_version_id FROM books
         ORDER BY id`,
      )
      .all() as {
      current_version_id: string | null;
      id: number;
    }[];
  } finally {
    database.close();
  }
}

async function createAnalyzeJob(input: {
  readonly archive: Buffer;
  readonly database: ReturnType<typeof openDatabase>;
  readonly name: string;
  readonly nowMs: number;
}) {
  const importId = createOpaqueId("import");
  const uploadRelativePath = `tmp/uploads/${importId}/original.zip`;
  const uploadDirectory = resolve(e2eDataRoot, "tmp", "uploads", importId);
  await mkdir(uploadDirectory, { recursive: true });
  await writeFile(resolve(uploadDirectory, "original.zip"), input.archive);
  new ImportRepository(input.database).createUploaded({
    expiresAtMs: input.nowMs + 86_400_000,
    id: importId,
    nowMs: input.nowMs,
    originalName: input.name,
    uploadRelativePath,
    uploadSha256: createHash("sha256").update(input.archive).digest("hex"),
    uploadSizeBytes: input.archive.byteLength,
  });
  return new JobRepository(input.database).create({
    importId,
    kind: "analyze_import",
    nowMs: input.nowMs,
  });
}

test("shows, cancels, retries and recovers durable work without changing publication", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await loginAsAdministrator(page, "192.0.2.17");

  const before = pointerSnapshot();
  const workerPid = Number(
    (await readFile(resolve(e2eDataRoot, "tmp", "worker.pid"), "utf8")).trim(),
  );
  expect(Number.isSafeInteger(workerPid)).toBe(true);
  expect(
    (await readFile(`/proc/${workerPid}/cmdline`, "utf8")).replaceAll(
      "\0",
      " ",
    ),
  ).toContain("dist/processes/worker/index.js");
  expect(workerPid).not.toBe(process.pid);
  process.kill(workerPid, "SIGTERM");
  await waitForProcessExit(workerPid);

  const database = openDatabase(resolve(e2eDataRoot, "db", "mirawind.sqlite"), {
    role: "worker",
  });
  const jobs = new JobRepository(database);
  const nowMs = Date.now();
  const archive = await readFile(
    resolve(e2eFixtureRoot, "high-confidence.zip"),
  );
  const expired = await createAnalyzeJob({
    archive,
    database,
    name: "recovery-expired.zip",
    nowMs: nowMs - 80_000,
  });
  jobs.claimNext({
    leaseOwner: "worker:simulated-dead-host",
    nowMs: nowMs - 70_000,
  });
  await mkdir(resolve(e2eDataRoot, "staging", expired.id), {
    recursive: true,
  });
  const queued = await createAnalyzeJob({
    archive,
    database,
    name: "recovery-manual.zip",
    nowMs,
  });
  database.close();

  await page.goto("/manage/tasks");
  const queuedCard = page.getByRole("listitem").filter({
    hasText: "recovery-manual.zip",
  });
  await expect(queuedCard).toBeVisible();
  await expect(queuedCard.locator("[data-state]")).toHaveAttribute(
    "data-state",
    "queued",
  );
  await queuedCard.getByRole("button", { name: "取消", exact: true }).click();
  await expect(queuedCard.locator("[data-state]")).toHaveAttribute(
    "data-state",
    "canceled",
  );
  await queuedCard.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator('[data-state="queued"]')).toHaveCount(1);

  const replacementWorker = await startWorkerProcess({
    dataRoot: e2eDataRoot,
    publicOrigin: e2eOrigin,
  });
  try {
    await expect
      .poll(
        () => {
          const check = openDatabase(
            resolve(e2eDataRoot, "db", "mirawind.sqlite"),
            { role: "worker" },
          );
          try {
            const terminal = check
              .prepare(
                `SELECT retry_of_job_id, state, automatic_retry_count
                 FROM jobs
                 WHERE retry_of_job_id IN (?, ?)
                 ORDER BY retry_of_job_id`,
              )
              .all(expired.id, queued.id) as {
              automatic_retry_count: number;
              retry_of_job_id: string;
              state: string;
            }[];
            return Object.fromEntries(
              terminal.map((job) => [
                job.retry_of_job_id,
                {
                  automatic_retry_count: job.automatic_retry_count,
                  state: job.state,
                },
              ]),
            );
          } finally {
            check.close();
          }
        },
        { timeout: 30_000 },
      )
      .toEqual({
        [expired.id]: {
          automatic_retry_count: 1,
          state: "succeeded",
        },
        [queued.id]: {
          automatic_retry_count: 0,
          state: "succeeded",
        },
      });

    const check = openDatabase(resolve(e2eDataRoot, "db", "mirawind.sqlite"), {
      role: "worker",
    });
    try {
      expect(new JobRepository(check).get(expired.id)).toMatchObject({
        errorCode: "JOB_LEASE_EXPIRED",
        state: "interrupted",
      });
      expect(new JobRepository(check).get(queued.id)).toMatchObject({
        errorCode: "JOB_CANCELED",
        state: "canceled",
      });
    } finally {
      check.close();
    }
    expect(
      pointerSnapshot().filter((book) =>
        before.some((existing) => existing.id === book.id),
      ),
    ).toEqual(before);
    await page.reload();
    const expiredCard = page.locator(`[data-job-id="${expired.id}"]`);
    await expect(expiredCard.locator("[data-state]")).toHaveAttribute(
      "data-state",
      "interrupted",
    );
    type HealthBody = {
      worker: {
        queue: { queuedCount: number; runningCount: number };
        recentAttempt: {
          memory: {
            peakProcessTreeRssBytes: number | null;
            status: "available" | "unavailable";
          };
          stages: readonly { durationMs: number; phase: string }[];
        } | null;
        schemaVersion: number;
      } | null;
    };
    let healthBody: HealthBody | undefined;
    await expect
      .poll(
        async () => {
          const health = await page.request.get("/api/manage/health");
          expect(health.status()).toBe(200);
          expect(health.headers()["cache-control"]).toBe("private, no-store");
          healthBody = (await health.json()) as HealthBody;
          return healthBody.worker?.recentAttempt?.stages.length ?? 0;
        },
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0);
    if (!healthBody) throw new Error("WORKER_HEALTH_MISSING");
    expect(healthBody.worker).toMatchObject({
      queue: {
        queuedCount: expect.any(Number),
        runningCount: expect.any(Number),
      },
      schemaVersion: 3,
    });
    expect(
      healthBody.worker?.recentAttempt?.stages.every(
        (stage) => stage.durationMs >= 0 && stage.phase.length > 0,
      ),
    ).toBe(true);
    const memory = healthBody.worker?.recentAttempt?.memory;
    expect(memory?.peakProcessTreeRssBytes === null).toBe(
      memory?.status === "unavailable",
    );
  } finally {
    if (replacementWorker.child.pid) {
      process.kill(replacementWorker.child.pid, "SIGTERM");
      await waitForProcessExit(replacementWorker.child.pid);
    }
  }
});
