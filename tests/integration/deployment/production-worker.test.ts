import { execFile, fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { captureFrozenJobInput } from "@/composition/worker/capture-frozen-input";
import {
  jobChildProtocolVersion,
  isChildToParentMessage,
  type JobResultMessage,
} from "@/entrypoints/worker/protocol";
import { BuildRepository } from "@/modules/publishing/adapters/sqlite/builds";
import { ImportRepository } from "@/modules/publishing/adapters/sqlite/imports";
import { JobRepository } from "@/modules/publishing/adapters/sqlite/jobs";
import { installIrDraft } from "../../helpers/ir-book";
import { withMigratedTestDatabase } from "../../helpers/database";
import { required } from "../../helpers/required";

it("renders a frozen IR candidate in production even when the process bundle was built under test", async () => {
  const output = await mkdtemp(resolve(".cache/production-worker-"));
  try {
    await promisify(execFile)(
      resolve("node_modules/.bin/vite"),
      ["build", "--config", "vite.processes.config.ts"],
      {
        env: {
          ...process.env,
          NODE_ENV: "test",
          MIRAWIND_PROCESS_OUT_DIR: output,
        },
        timeout: 30000,
      },
    );
    await withMigratedTestDatabase(async ({ database }, { layout }) => {
      const fixture = await installIrDraft(database, layout);
      const job = required(
        new JobRepository(database).claimNext({
          leaseOwner: "test",
          nowMs: Date.now(),
        }),
      );
      const input = await captureFrozenJobInput({
        database,
        layout,
        job,
        builds: new BuildRepository(database),
        imports: new ImportRepository(database),
      });
      const child = fork(resolve(output, "worker/job-child.js"), [], {
        env: {
          ...process.env,
          NODE_ENV: "production",
          MIRAWIND_JOB_STORAGE_ROOT: layout.root,
        },
        execArgv: [],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      const exited = new Promise<void>((resolveExit) =>
        child.once("exit", () => resolveExit()),
      );
      try {
        const result = new Promise<JobResultMessage>(
          (resolveResult, reject) => {
            child.once("error", reject);
            child.once("exit", () =>
              reject(new Error("WORKER_EXITED_WITHOUT_RESULT")),
            );
            child.on("message", (message) => {
              if (isChildToParentMessage(message) && message.type === "result")
                resolveResult(message);
            });
          },
        );
        child.send({
          type: "run",
          protocolVersion: jobChildProtocolVersion,
          input,
        });
        expect(await result).toMatchObject({
          ok: true,
          result: { kind: "book_build_artifact", pageCount: 1 },
        });
        const version = database
          .prepare("SELECT version_id FROM jobs WHERE id=?")
          .get(fixture.build.jobId) as { version_id: string };
        const html = await readFile(
          resolve(
            layout.bookDirectory,
            String(fixture.book.book_id),
            "builds",
            version.version_id,
            "published/pages/1.html",
          ),
          "utf8",
        );
        expect(html).toContain("Body");
      } finally {
        child.kill("SIGTERM");
        await exited;
      }
    });
  } finally {
    await rm(output, { force: true, recursive: true });
  }
}, 45000);
