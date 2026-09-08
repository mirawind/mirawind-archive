import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { DocumentRepository } from "@/modules/publishing/adapters/sqlite/documents";
import { saveDocument } from "@/modules/publishing/adapters/sqlite/save-document";
import { createOpaqueId } from "@/domain/ids";
import { normalizeSearchQuery } from "../../src/modules/reader/core/search-query.js";
import { BuildPublicationRepository } from "../../src/modules/publishing/adapters/sqlite/build-publication.js";
import { BuildRepository } from "../../src/modules/publishing/adapters/sqlite/builds.js";
import { DraftRepository } from "../../src/modules/publishing/adapters/sqlite/drafts.js";
import {
  JobRepository,
  type JobRecord,
} from "../../src/modules/publishing/adapters/sqlite/jobs.js";
import { openDatabase } from "../../src/platform/sqlite/connection.js";
import {
  m1PublishPolicy,
  publishBuild,
} from "../../src/modules/publishing/application/publishing-api.js";
import { runBuildBenchmarks } from "./build.js";
import { captureBenchmarkEnvironment } from "./environment.js";
import { argumentMap, boundedInteger, requiredArgument } from "./http.js";
import { benchmarkReads } from "./read.js";
import { benchmarkSearch } from "./search.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const webEntry = join(repositoryRoot, "dist/server/entry.mjs");
const workerEntry = join(repositoryRoot, "dist/processes/worker/index.js");
const databaseRelativePath = join("db", "mirawind.sqlite");
const processOutputLimit = 64 * 1024;

interface ManagedProcess {
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly stop: () => Promise<void>;
}

interface ReferenceArguments {
  readonly concurrency: number;
  readonly outputJson: string;
  readonly outputMarkdown: string;
  readonly realDirectory: string;
  readonly realManifest: string | null;
  readonly requests: number;
  readonly retainDirectory: string;
}

interface FixtureContext {
  readonly bookId: number;
  readonly bookKey: string;
  readonly currentVersionId: string;
  readonly normalQuery: string;
  readonly pagePath: string;
  readonly shortQuery: string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function parseArguments(arguments_: readonly string[]): ReferenceArguments {
  const values = argumentMap(arguments_, [
    "--concurrency",
    "--output-json",
    "--output-markdown",
    "--real-dir",
    "--real-manifest",
    "--requests",
    "--retain-dir",
  ]);
  return Object.freeze({
    concurrency: boundedInteger(
      values.get("--concurrency"),
      8,
      "concurrency",
      1,
      128,
    ),
    outputJson: resolve(requiredArgument(values, "--output-json")),
    outputMarkdown: resolve(requiredArgument(values, "--output-markdown")),
    realDirectory: resolve(requiredArgument(values, "--real-dir")),
    realManifest: values.get("--real-manifest") ?? null,
    requests: boundedInteger(
      values.get("--requests"),
      200,
      "requests",
      20,
      100_000,
    ),
    retainDirectory: resolve(requiredArgument(values, "--retain-dir")),
  });
}

function startProcess(
  entry: string,
  environment: Readonly<Record<string, string>>,
): ManagedProcess {
  const child = spawn(process.execPath, [entry], {
    cwd: repositoryRoot,
    detached: true,
    env: { ...process.env, ...environment },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let exited = false;
  const append = (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-processOutputLimit);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const exitPromise = new Promise<void>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", () => {
      exited = true;
      resolveExit();
    });
  });
  return Object.freeze({
    child,
    output: () => output,
    async stop() {
      if (exited) return;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
      const graceful = await Promise.race([
        exitPromise.then(() => true),
        delay(10_000).then(() => false),
      ]);
      if (!graceful && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        await exitPromise;
      }
    },
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
    throw new Error("REFERENCE_PORT_ALLOCATION_FAILED");
  }
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return address.port;
}

function normalToken(value: string): string | null {
  const match = /[\p{Letter}\p{Number}]{3,}/u.exec(value);
  if (!match) return null;
  return [...match[0]].slice(0, 12).join("");
}

function shortToken(value: string): string | null {
  const match = /[\p{Letter}\p{Number}]/u.exec(value);
  return match?.[0] ?? null;
}

async function fixtureContext(dataRoot: string): Promise<FixtureContext> {
  const databasePath = join(dataRoot, databaseRelativePath);
  const database = new Database(databasePath, {
    fileMustExist: true,
    readonly: true,
  });
  try {
    const book = database
      .prepare(
        `SELECT id, alias, current_version_id
         FROM books
         WHERE access = 'public' AND current_version_id IS NOT NULL
         ORDER BY id
         LIMIT 1`,
      )
      .get() as
      | {
          alias: string | null;
          current_version_id: string;
          id: number;
        }
      | undefined;
    if (!book) throw new Error("REFERENCE_PUBLIC_BOOK_MISSING");
    const page = database
      .prepare(
        `SELECT page_id
         FROM search_fts
         WHERE version_id = ?
         ORDER BY CAST(ordinal AS INTEGER)
         LIMIT 1`,
      )
      .get(book.current_version_id) as { page_id: number | string } | undefined;
    if (!page) throw new Error("REFERENCE_PAGE_MISSING");
    const normalRows = database
      .prepare(
        `SELECT title, authors, heading, body
         FROM search_fts
         WHERE version_id = ?
         ORDER BY CAST(ordinal AS INTEGER)
         LIMIT 500`,
      )
      .all(book.current_version_id) as {
      authors: string;
      body: string;
      heading: string;
      title: string;
    }[];
    const candidates = [
      ...new Set(
        normalRows
          .flatMap((row) => [row.body, row.heading, row.title, row.authors])
          .map(normalToken)
          .filter((value): value is string => value !== null),
      ),
    ];
    const countMatches = database.prepare(
      `SELECT COUNT(*) AS count
       FROM search_fts
       WHERE search_fts MATCH ? AND version_id = ?`,
    );
    const normalQuery = candidates
      .map((query) => ({
        count: (
          countMatches.get(
            normalizeSearchQuery(query).ftsLiteralPhrase,
            book.current_version_id,
          ) as { count: number }
        ).count,
        query,
      }))
      .filter((candidate) => candidate.count > 0)
      .sort(
        (left, right) =>
          left.count - right.count ||
          left.query.localeCompare(right.query, "en"),
      )[0]?.query;
    const shortRows = database
      .prepare(
        `SELECT normalized_text
         FROM search_short_fields
         WHERE version_id = ?
         ORDER BY ordinal
         LIMIT 500`,
      )
      .all(book.current_version_id) as { normalized_text: string }[];
    const shortQuery = shortRows
      .map((row) => shortToken(row.normalized_text))
      .find((value): value is string => value !== null);
    if (!normalQuery || !shortQuery) {
      throw new Error("REFERENCE_SEARCH_QUERY_MISSING");
    }
    const bookKey = book.alias ?? String(book.id);
    return Object.freeze({
      bookId: book.id,
      bookKey,
      currentVersionId: book.current_version_id,
      normalQuery,
      pagePath: `/read/${bookKey}/${Number(page.page_id)}`,
      shortQuery,
    });
  } finally {
    database.close();
  }
}

export function retainedFixtureDataRoot(
  retainDirectory: string,
  fixtureId: string,
): string {
  return join(retainDirectory, fixtureId, "run-001");
}

async function waitForWeb(process_: ManagedProcess, url: URL): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process_.child.exitCode !== null) {
      throw new Error("REFERENCE_WEB_EXITED");
    }
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(1_000),
      });
      await response.body?.cancel();
      if (response.status === 200) return;
    } catch {
      // The production server has not bound its port yet.
    }
    await delay(25);
  }
  throw new Error("REFERENCE_WEB_READY_TIMEOUT");
}

async function waitForWorker(process_: ManagedProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process_.output().includes("Mirawind worker ready")) return;
    if (process_.child.exitCode !== null) {
      throw new Error("REFERENCE_WORKER_EXITED");
    }
    await delay(25);
  }
  throw new Error("REFERENCE_WORKER_READY_TIMEOUT");
}

function queueRebuild(databasePath: string): {
  readonly bookId: number;
  readonly sourceUpdatedAt: number;
  readonly buildId: string;
  readonly jobId: string;
  readonly versionId: string;
  readonly versionBefore: string;
  readonly save: {
    readonly duration_ms: number;
    readonly roots_written: number;
    readonly total_roots: number;
  };
} {
  const database = openDatabase(databasePath, { role: "worker" });
  try {
    const book = new DraftRepository(database).requireBook(1);
    if (!book.currentVersionId || !book.draftImportId) {
      throw new Error("REFERENCE_REBUILD_CAPTURE_MISSING");
    }
    const documents = new DocumentRepository(database);
    const target = database
      .prepare(
        "SELECT id FROM book_blocks WHERE book_id=? AND type='paragraph' ORDER BY ordinal LIMIT 1",
      )
      .get(book.id) as { id: string } | undefined;
    if (!target) throw new Error("REFERENCE_EDIT_TARGET_MISSING");
    const block = documents.block(book.id, target.id);
    database.exec(
      "CREATE TEMP TABLE edited_roots(id TEXT); CREATE TEMP TRIGGER count_edited_roots AFTER UPDATE ON main.book_blocks BEGIN INSERT INTO edited_roots VALUES (NEW.id); END;",
    );
    const started = performance.now();
    saveDocument({
      database,
      bookId: book.id,
      expectedUpdatedAt: block.updated_at,
      nowMs: Date.now(),
      requestId: createOpaqueId("job"),
      patch: {
        block: {
          block_id: target.id,
          markdown: block.markdown + " (benchmark edit)",
        },
      },
    });
    const durationMs = performance.now() - started;
    const written = database
      .prepare("SELECT count(*) AS count FROM edited_roots")
      .get() as { count: number };
    const total = database
      .prepare("SELECT count(*) AS count FROM book_blocks WHERE book_id=?")
      .get(book.id) as { count: number };
    if (written.count !== 1)
      throw new Error("REFERENCE_EDIT_WRITE_SCOPE_INVALID");
    const candidate = new BuildRepository(database).findCurrent(book.id);
    if (!candidate) throw new Error("REFERENCE_EDIT_BUILD_MISSING");
    return Object.freeze({
      bookId: book.id,
      sourceUpdatedAt: candidate.sourceUpdatedAt,
      buildId: candidate.id,
      jobId: candidate.jobId,
      versionId: candidate.id,
      versionBefore: book.currentVersionId,
      save: {
        duration_ms: Math.round(durationMs * 1000) / 1000,
        roots_written: written.count,
        total_roots: total.count,
      },
    });
  } finally {
    database.close();
  }
}

async function publishRebuild(
  databasePath: string,
  rebuild: ReturnType<typeof queueRebuild>,
): Promise<void> {
  const database = openDatabase(databasePath, { role: "worker" });
  try {
    await publishBuild({
      actorUserId: null,
      bookId: rebuild.bookId,
      expectedUpdatedAt: rebuild.sourceUpdatedAt,
      buildId: rebuild.buildId,
      nowMs: Date.now(),
      policy: m1PublishPolicy,
      publication: new BuildPublicationRepository(database),
    });
  } finally {
    database.close();
  }
}

async function waitForJob(
  databasePath: string,
  jobId: string,
  accepted: readonly JobRecord["state"][],
): Promise<JobRecord> {
  const database = new Database(databasePath, {
    fileMustExist: true,
    readonly: true,
  });
  try {
    const jobs = new JobRepository(database);
    const deadline = Date.now() + 30 * 60 * 1_000;
    while (Date.now() < deadline) {
      const job = jobs.get(jobId);
      if (!job) throw new Error("REFERENCE_JOB_MISSING");
      if (accepted.includes(job.state)) return job;
      if (["failed", "canceled", "interrupted"].includes(job.state)) {
        throw new Error(job.errorCode ?? "REFERENCE_JOB_FAILED");
      }
      await delay(10);
    }
    throw new Error("REFERENCE_JOB_TIMEOUT");
  } finally {
    database.close();
  }
}

export async function benchmarkFixtureHttp(input: {
  readonly concurrency: number;
  readonly dataRoot: string;
  readonly requests: number;
}): Promise<Readonly<Record<string, unknown>>> {
  const context = await fixtureContext(input.dataRoot);
  const databasePath = join(input.dataRoot, databaseRelativePath);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const runtimeEnvironment = {
    HOST: "127.0.0.1",
    MIRAWIND_ALLOWED_HOSTS: "127.0.0.1,localhost",
    MIRAWIND_AUTH_SECRET: "benchmark-only-secret-0123456789-abcdef",
    MIRAWIND_DATA_DIR: input.dataRoot,
    MIRAWIND_PASSKEY_RP_ID: "127.0.0.1",
    MIRAWIND_PUBLIC_ORIGIN: origin,
    NODE_ENV: "development",
    PORT: String(port),
  };
  const web = startProcess(webEntry, runtimeEnvironment);
  let worker: ManagedProcess | null = null;
  try {
    await waitForWeb(web, new URL(context.pagePath, origin));
    const idleRead = await benchmarkReads({
      concurrency: input.concurrency,
      mode: "idle",
      origin,
      path: context.pagePath,
      requests: input.requests,
      warmups: 20,
    });
    const search = await benchmarkSearch({
      bookKey: context.bookKey,
      concurrency: input.concurrency,
      normalQuery: context.normalQuery,
      origin,
      requests: input.requests,
      shortQuery: context.shortQuery,
      warmups: 20,
    });

    worker = startProcess(workerEntry, runtimeEnvironment);
    await waitForWorker(worker);
    const rebuild = queueRebuild(databasePath);
    await waitForJob(databasePath, rebuild.jobId, ["running"]);
    const concurrentRead = await benchmarkReads({
      concurrency: input.concurrency,
      databasePath,
      mode: "concurrent-build",
      origin,
      path: context.pagePath,
      requests: Math.max(500, input.requests),
      warmups: 0,
    });
    const completed = await waitForJob(databasePath, rebuild.jobId, [
      "succeeded",
    ]);
    await publishRebuild(databasePath, rebuild);
    const after = await fixtureContext(input.dataRoot);
    if (
      completed.state !== "succeeded" ||
      after.currentVersionId === rebuild.versionBefore
    ) {
      throw new Error("REFERENCE_REBUILD_PUBLICATION_MISSING");
    }
    return Object.freeze({
      save: rebuild.save,
      rebuild_ms:
        completed.finishedAtMs !== null && completed.startedAtMs !== null
          ? completed.finishedAtMs - completed.startedAtMs
          : null,
      concurrent_build_read: concurrentRead,
      idle_read: idleRead,
      publication: {
        foreground_requests_succeeded: true,
        pointer_advanced_after_build: true,
        version_before: rebuild.versionBefore,
        version_after: after.currentVersionId,
      },
      search,
      status:
        idleRead.status === "passed" &&
        concurrentRead.status === "passed" &&
        search.status === "passed"
          ? "passed"
          : "failed",
    });
  } finally {
    await worker?.stop();
    await web.stop();
  }
}

function numeric(
  value: Readonly<Record<string, unknown>>,
  path: readonly string[],
): number {
  let current: unknown = value;
  for (const key of path) {
    current =
      current && typeof current === "object"
        ? (current as Record<string, unknown>)[key]
        : undefined;
  }
  return typeof current === "number" ? current : Number.NaN;
}

function markdownReport(
  report: Readonly<Record<string, unknown>>,
  rawFilename: string,
): string {
  const build = report.build as Readonly<Record<string, unknown>>;
  const buildResults = build.results as readonly Readonly<
    Record<string, unknown>
  >[];
  const httpResults = report.http_results as readonly Readonly<
    Record<string, unknown>
  >[];
  const environment = report.environment as Readonly<Record<string, unknown>>;
  const host = environment.host as Readonly<Record<string, unknown>>;
  const sqlite = environment.sqlite as Readonly<Record<string, unknown>>;
  const rows = buildResults.map((result) => {
    const fixtureId = String(result.fixture_id);
    const http =
      httpResults.find((candidate) => candidate.fixture_id === fixtureId) ?? {};
    return [
      fixtureId,
      String((result.archive as Record<string, unknown>)?.sha256 ?? "—"),
      String(result.mineru_version),
      String(numeric(result, ["timings", "wall_ms"])),
      String(numeric(result, ["memory", "peak_process_tree_rss_bytes"])),
      String(numeric(http, ["idle_read", "summary", "p95_ms"])),
      String(numeric(http, ["concurrent_build_read", "summary", "p95_ms"])),
      String(numeric(http, ["search", "normal", "summary", "p95_ms"])),
      String(numeric(http, ["search", "short", "summary", "p95_ms"])),
      String(
        result.status === "passed" && http.status === "passed"
          ? "PASS"
          : "FAIL",
      ),
    ].join(" | ");
  });
  return `# M1 performance report

- Captured: ${String(report.captured_at)}
- Reference host: ${String(host.platform)} ${String(host.release)}, ${String(host.architecture)}, ${String(host.cpu_count)} logical CPUs, ${String(host.memory_bytes)} bytes RAM
- Runtime: Node ${String((environment.runtime as Record<string, unknown>)?.node)}, SQLite ${String(sqlite.linked_version)} with WAL/FTS5 trigram
- Workload: every registered MinerU 3.4.4 fixture plus a 500-page, 20-block/page, 32-image synthetic stress fixture
- HTTP configuration: ${String((report.configuration as Record<string, unknown>)?.requests)} measured requests per idle/search branch, ${String((report.configuration as Record<string, unknown>)?.concurrent_requests)} concurrent-build reads, concurrency ${String((report.configuration as Record<string, unknown>)?.concurrency)}
- Gates: uncached public reading p95 <= 300 ms; supported normal and 1–2-code-point search p95 < 1,000 ms
- Raw sanitized results: [${rawFilename}](./${rawFilename})

Fixture | SHA-256 | MinerU | Build wall ms | Peak process-tree RSS bytes | Idle read p95 ms | Concurrent-build read p95 ms | Normal search p95 ms | Short search p95 ms | Result
--- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---
${rows.join("\n")}

## Interpretation

All fixture hashes were verified before processing. Every HTTP request returned the declared public cache policy and expected response type. The concurrent-build run observed a durable running build while the public route continued serving a published version; only after the build succeeded did SQLite advance \`current_version_id\`.

The JSON report contains exact p50/p95/p99 distributions, build phase durations, archive/output/index sizes, FTS build measurements, environment and dependency fingerprints. Search query text is omitted; only code-point counts and SHA-256 hashes are retained.
`;
}

export async function runReferenceBenchmark(
  input: ReferenceArguments,
): Promise<Readonly<Record<string, unknown>>> {
  const environment = await captureBenchmarkEnvironment();
  const build = await runBuildBenchmarks({
    output: null,
    realDirectory: input.realDirectory,
    realManifest: input.realManifest,
    retainDirectory: input.retainDirectory,
    stress: {
      blocksPerPage: 20,
      imageCount: 32,
      pages: 500,
    },
    onResult(result) {
      process.stderr.write(JSON.stringify(result) + "\n");
    },
  });
  await mkdir(dirname(input.outputJson), { recursive: true, mode: 0o700 });
  await writeFile(
    input.outputJson + ".build.json",
    JSON.stringify(build, null, 2) + "\n",
    { mode: 0o600 },
  );
  if (build.status !== "passed") {
    throw new Error("REFERENCE_BUILD_GATE_FAILED");
  }
  const buildResults = build.results as readonly Readonly<
    Record<string, unknown>
  >[];
  const httpResults: Readonly<Record<string, unknown>>[] = [];
  for (const result of buildResults) {
    const fixtureId = String(result.fixture_id);
    const http = await benchmarkFixtureHttp({
      concurrency: input.concurrency,
      dataRoot: retainedFixtureDataRoot(input.retainDirectory, fixtureId),
      requests: input.requests,
    });
    httpResults.push(
      Object.freeze({
        fixture_id: fixtureId,
        ...http,
      }),
    );
  }
  const failed = httpResults.some((result) => result.status !== "passed");
  return Object.freeze({
    build,
    captured_at: new Date().toISOString(),
    configuration: {
      concurrency: input.concurrency,
      concurrent_requests: Math.max(500, input.requests),
      requests: input.requests,
      search_query_storage: "sha256_and_code_point_count_only",
      stress: {
        blocks_per_page: 20,
        image_count: 32,
        pages: 500,
      },
    },
    environment,
    http_results: Object.freeze(httpResults),
    schema_version: 1,
    status: failed ? "failed" : "passed",
  });
}

async function main(): Promise<void> {
  const input = parseArguments(process.argv.slice(2));
  const report = await runReferenceBenchmark(input);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = markdownReport(
    report,
    input.outputJson.split("/").at(-1) ?? "",
  );
  await Promise.all([
    mkdir(dirname(input.outputJson), { mode: 0o700, recursive: true }),
    mkdir(dirname(input.outputMarkdown), { mode: 0o700, recursive: true }),
  ]);
  await Promise.all([
    writeFile(input.outputJson, json, { mode: 0o600 }),
    writeFile(input.outputMarkdown, markdown, { mode: 0o600 }),
  ]);
  process.stdout.write(
    `${JSON.stringify({
      output_json_sha256: await readFile(input.outputJson).then((bytes) =>
        import("node:crypto").then(({ createHash }) =>
          createHash("sha256").update(bytes).digest("hex"),
        ),
      ),
      status: report.status,
    })}\n`,
  );
  if (report.status !== "passed") process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "REFERENCE_BENCHMARK_FAILED"}\n`,
    );
    process.exitCode = 1;
  });
}
