import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import Database from "better-sqlite3";

import { openDatabase } from "../../src/platform/sqlite/connection.js";
import { applyMigrations } from "../../src/platform/sqlite/migrate.js";
import { loadMigrationManifest } from "../../src/platform/sqlite/migration-manifest.js";
import { createStorageLayout } from "../../src/platform/filesystem/storage-layout.js";
import {
  argumentMap,
  boundedInteger,
  runConcurrentRequests,
  summarizeLatencies,
  timedFetch,
} from "./http.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const webEntry = join(repositoryRoot, "dist/server/entry.mjs");

interface Arguments {
  readonly concurrency: number;
  readonly outputJson: string | null;
  readonly outputMarkdown: string | null;
  readonly requests: number;
  readonly warmups: number;
}

function parseArguments(arguments_: readonly string[]): Arguments {
  const values = argumentMap(arguments_, [
    "--concurrency",
    "--output-json",
    "--output-markdown",
    "--requests",
    "--warmups",
  ]);
  return Object.freeze({
    concurrency: boundedInteger(
      values.get("--concurrency"),
      4,
      "concurrency",
      1,
      32,
    ),
    outputJson: values.get("--output-json")
      ? resolve(String(values.get("--output-json")))
      : null,
    outputMarkdown: values.get("--output-markdown")
      ? resolve(String(values.get("--output-markdown")))
      : null,
    requests: boundedInteger(
      values.get("--requests"),
      40,
      "requests",
      20,
      10_000,
    ),
    warmups: boundedInteger(values.get("--warmups"), 5, "warmups", 0, 1_000),
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("LIBRARY_BENCHMARK_PORT_INVALID");
  }
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  return address.port;
}

function seedBooks(database: Database.Database, count: number): void {
  const insertBook = database.prepare(
    `INSERT INTO books (
       id, alias, access, title_cache, created_at, updated_at
     ) VALUES (?, ?, 'public', ?, 1, 1)`,
  );
  const insertImport = database.prepare(
    `INSERT INTO imports (
       id, original_name, state, upload_rel_path, upload_size_bytes, upload_sha256,
       book_id, created_at, updated_at, expires_at
     ) VALUES (?, 'benchmark.zip', 'draft_ready', ?, 1, ?, ?, 1, 1, 9999999999999)`,
  );
  const insertJob = database.prepare(
    `INSERT INTO jobs (
       id, kind, state, book_id, version_id, import_id,
       captured_source_updated_at, attempt, automatic_retry_count, phase,
       progress_json, created_at, started_at, finished_at
     ) VALUES (?, 'build_book', 'succeeded', ?, ?, ?, 1000, 1, 0,
               'complete', '{}', 1, 1, 1)`,
  );
  const insertVersion = database.prepare(
    `INSERT INTO book_versions (
       id, book_id, import_id, source_updated_at, predecessor_version_id,
       state, version_rel_path, manifest_schema_version, manifest_sha256,
       version_marker_sha256, semantic_digest, compiler_version,
       renderer_version, preview_version, reader_version,
       blocking_diagnostic_count, complete_at, published_at,
       verified_at, created_by_job_id
     ) VALUES (?, ?, ?, 1000, NULL, 'published', ?, 5, ?, ?, ?,
               'compiler-v8', 'semantic-html-v8-katex-0.18.1',
               'draft-preview-v8', 'mirawind-reader-v5-tailwind-4.3.3',
               0, 1, 1, 1, ?)`,
  );
  const insertPresentation = database.prepare(
    `INSERT INTO book_version_presentations (
       version_id, book_id, source_updated_at, projection_schema_version,
       alias, title, metadata_json, cover_resource_id, first_page_id,
       first_page_alias, toc_preview_json, toc_entry_count,
       projection_sha256, created_at
     ) VALUES (?, ?, 1000, 3, ?, ?, ?, NULL, 1, NULL, ?, 1, ?, 1)`,
  );
  const publish = database.prepare(
    `UPDATE books SET draft_import_id = ?,
                      current_version_id = ?
     WHERE id = ?`,
  );
  database.transaction(() => {
    for (let id = 1; id <= count; id += 1) {
      const suffix = String(id).padStart(6, "0");
      const alias = `bench-book-${id}`;
      const title = `Benchmark Book ${suffix}`;
      const importId = `imp_library_benchmark_${suffix}`;
      const versionId = `ver_library_benchmark_${suffix}`;
      const jobId = `job_library_benchmark_${suffix}`;
      const sha = createHash("sha256").update(suffix).digest("hex");
      insertBook.run(id, alias, title);
      insertImport.run(importId, `tmp/${suffix}.zip`, sha, id);
      insertJob.run(jobId, id, versionId, importId);
      insertVersion.run(
        versionId,
        id,
        importId,
        `books/${id}/builds/${versionId}`,
        sha,
        sha,
        sha,
        jobId,
      );
      insertPresentation.run(
        versionId,
        id,
        alias,
        title,
        JSON.stringify({ authors: [`Author ${suffix}`] }),
        JSON.stringify([
          {
            block_id: `blk_library_benchmark_${suffix}`,
            level: 1,
            number: "1",
            page_id: 1,
            role: "body",
            title: "Opening",
          },
        ]),
        sha,
      );
      publish.run(importId, versionId, id);
    }
    database
      .prepare(
        `INSERT INTO jobs (
           id, kind, state, attempt, automatic_retry_count, lease_owner,
           lease_until, heartbeat_at, phase, progress_json, created_at,
           started_at
         ) VALUES (
           'job_library_benchmark_writer', 'analyze_import', 'running', 1, 0,
           'benchmark-rebuild', 9999999999999, 1, 'rebuilding_projection',
           '{"processed":0}', 1, 1
         )`,
      )
      .run();
  })();
}

async function waitForWeb(origin: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/library`);
      if (response.ok) return;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("LIBRARY_BENCHMARK_WEB_TIMEOUT");
}

async function benchmarkRoute(input: {
  readonly concurrency: number;
  readonly origin: string;
  readonly path: string;
  readonly requests: number;
  readonly warmups: number;
}) {
  const request = (index: number) => {
    const url = new URL(input.path, input.origin);
    url.searchParams.set("benchmark_request", String(index));
    return timedFetch({
      expectedContentType: "text/html",
      inspect(response) {
        if (
          response.headers.get("cache-control") !==
          "public, max-age=0, must-revalidate"
        ) {
          throw new Error("LIBRARY_BENCHMARK_CACHE_INVALID");
        }
      },
      url,
    });
  };
  for (let index = 0; index < input.warmups; index += 1) {
    await request(-index - 1);
  }
  const latencies = await runConcurrentRequests({
    concurrency: input.concurrency,
    request,
    requests: input.requests,
  });
  const summary = summarizeLatencies(latencies);
  return Object.freeze({
    route: input.path,
    status: summary.p95_ms <= 300 ? "passed" : "failed",
    summary,
    target_p95_ms: 300,
  });
}

export async function runLibraryBenchmark(input: Arguments) {
  const dataRoot = await mkdtemp(join(tmpdir(), "mirawind-library-benchmark-"));
  const layout = await createStorageLayout(dataRoot);
  const database = openDatabase(
    join(layout.databaseDirectory, "mirawind.sqlite"),
    { role: "worker" },
  );
  applyMigrations(database, await loadMigrationManifest());
  seedBooks(database, 1_000);
  database.close();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [webEntry], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      MIRAWIND_ALLOWED_HOSTS: "127.0.0.1,localhost",
      MIRAWIND_AUTH_SECRET: randomBytes(32).toString("hex"),
      MIRAWIND_DATA_DIR: dataRoot,
      MIRAWIND_PASSKEY_RP_ID: "127.0.0.1",
      MIRAWIND_PUBLIC_ORIGIN: origin,
      NODE_ENV: "test",
      PORT: String(port),
    },
    stdio: "ignore",
  });
  const writer = new Database(
    join(layout.databaseDirectory, "mirawind.sqlite"),
  );
  let processed = 0;
  const writerTimer = setInterval(() => {
    processed += 1;
    writer
      .prepare(
        `UPDATE jobs SET heartbeat_at = ?, progress_json = ?
         WHERE id = 'job_library_benchmark_writer'`,
      )
      .run(Date.now(), JSON.stringify({ processed }));
    createHash("sha256").update(randomBytes(4_096)).digest();
  }, 25);
  try {
    await waitForWeb(origin);
    const library = await benchmarkRoute({
      ...input,
      origin,
      path: "/library",
    });
    const details = await benchmarkRoute({
      ...input,
      origin,
      path: "/books/bench-book-500",
    });
    const report = Object.freeze({
      background_queue_writer: {
        heartbeat_writes: processed,
        job_state: "running",
        observed: processed > 0,
      },
      book_count: 1_000,
      concurrency: input.concurrency,
      details,
      library,
      requests_per_route: input.requests,
      schema_version: 1,
      status:
        library.status === "passed" &&
        details.status === "passed" &&
        processed > 0
          ? "passed"
          : "failed",
      warmups_per_route: input.warmups,
    });
    return report;
  } finally {
    clearInterval(writerTimer);
    writer.close();
    child.kill("SIGTERM");
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveExit();
      } else {
        child.once("exit", () => resolveExit());
        setTimeout(() => {
          child.kill("SIGKILL");
          resolveExit();
        }, 5_000).unref();
      }
    });
    await rm(dataRoot, { force: true, recursive: true });
  }
}

function markdown(report: Awaited<ReturnType<typeof runLibraryBenchmark>>) {
  return `# M2a library performance

- Status: **${report.status}**
- Fixture: ${report.book_count} current public books
- Simulated queue heartbeat contention observed: ${report.background_queue_writer.observed}
- Requests: ${report.requests_per_route} per route at concurrency ${report.concurrency}
- Library p95: ${report.library.summary.p95_ms} ms (target ≤ 300 ms)
- Details p95: ${report.details.summary.p95_ms} ms (target ≤ 300 ms)
`;
}

async function main(): Promise<void> {
  const input = parseArguments(process.argv.slice(2));
  const report = await runLibraryBenchmark(input);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (input.outputJson) {
    await mkdir(dirname(input.outputJson), { mode: 0o700, recursive: true });
    await writeFile(input.outputJson, json, { mode: 0o600 });
  }
  if (input.outputMarkdown) {
    await mkdir(dirname(input.outputMarkdown), {
      mode: 0o700,
      recursive: true,
    });
    await writeFile(input.outputMarkdown, markdown(report), { mode: 0o600 });
  }
  process.stdout.write(json);
  if (report.status !== "passed") process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "LIBRARY_BENCHMARK_FAILED"}\n`,
    );
    process.exitCode = 1;
  });
}
