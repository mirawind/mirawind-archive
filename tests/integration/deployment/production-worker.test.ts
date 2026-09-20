import { execFile, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
import { atomicWriteFile } from "@/platform/filesystem/atomic-file";
import { DocumentRepository } from "@/modules/publishing/adapters/sqlite/documents";
import { serializeBookDocument } from "@/modules/publishing/core/content/book-document";

it.each(["render", "content-budget"] as const)(
  "runs a production child from a test-built bundle: %s",
  async (scenario) => {
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
        let input = await captureFrozenJobInput({
          database,
          layout,
          job,
          builds: new BuildRepository(database),
          imports: new ImportRepository(database),
        });
        if (scenario === "content-budget") {
          if (input.kind !== "build_book")
            throw new Error("BUILD_INPUT_EXPECTED");
          const book = structuredClone(fixture.book);
          for (let group = 0; group < 6; group++)
            book.blocks.push({
              type: "quote",
              id: `blk_budget_group_${String(group).padStart(8, "0")}`,
              content: Array.from({ length: 17000 }, (_, index) => ({
                type: "divider" as const,
                id: `blk_budget_child_${group}_${String(index).padStart(8, "0")}`,
              })),
            });
          const json = serializeBookDocument(book);
          await atomicWriteFile(
            resolve(layout.root, input.inputRelativePath),
            json,
            { mode: 0o400 },
          );
          input = {
            ...input,
            documentSha256: createHash("sha256").update(json).digest("hex"),
          };
        }
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
                if (
                  isChildToParentMessage(message) &&
                  message.type === "result"
                )
                  resolveResult(message);
              });
            },
          );
          child.send({
            type: "run",
            protocolVersion: jobChildProtocolVersion,
            input,
          });
          const outcome = await result;
          if (scenario === "content-budget") {
            expect(outcome).toMatchObject({
              ok: false,
              safeErrorClass: "content",
              safeErrorCode: "BOOK_DOCUMENT_LIMIT_EXCEEDED",
            });
            expect(
              new DocumentRepository(database).read(fixture.book.book_id),
            ).toEqual(fixture.book);
            await expect(
              stat(resolve(layout.root, "staging", job.id)),
            ).rejects.toMatchObject({ code: "ENOENT" });
            return;
          }
          expect(outcome).toMatchObject({
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
  },
  45000,
);
