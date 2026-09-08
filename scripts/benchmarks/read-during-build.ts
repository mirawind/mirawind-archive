import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { BuildRepository } from "@/modules/publishing/adapters/sqlite/builds";
import { DocumentRepository } from "@/modules/publishing/adapters/sqlite/documents";
import {
  argumentMap,
  boundedInteger,
  hashedInput,
  requiredArgument,
  runConcurrentRequests,
  summarizeLatencies,
  timedFetch,
  type LatencySummary,
} from "./http.js";

interface BranchResult {
  readonly observed_build_requests: number;
  readonly requests: number;
  readonly status: "failed" | "passed";
  readonly summary: LatencySummary;
  readonly target_p95_ms: number;
}

export interface ReadDuringBuildReport {
  readonly page: BranchResult;
  readonly resource: BranchResult;
  readonly schema_version: 1;
  readonly search: BranchResult & { readonly query_sha256: string };
  readonly status: "failed" | "passed";
}

export interface ReadDuringBuildSamples {
  readonly normalQuery: string;
  readonly page: readonly number[];
  readonly pageObservedBuildRequests: number;
  readonly resource: readonly number[];
  readonly resourceObservedBuildRequests: number;
  readonly search: readonly number[];
  readonly searchObservedBuildRequests: number;
}

function branch(
  samples: readonly number[],
  observedBuildRequests: number,
  targetP95Ms: number,
): BranchResult {
  const summary = summarizeLatencies(samples);
  const passed =
    observedBuildRequests === samples.length && summary.p95_ms <= targetP95Ms;
  return Object.freeze({
    observed_build_requests: observedBuildRequests,
    requests: samples.length,
    status: passed ? "passed" : "failed",
    summary,
    target_p95_ms: targetP95Ms,
  });
}

export function buildReadDuringBuildReport(
  samples: ReadDuringBuildSamples,
): ReadDuringBuildReport {
  if (samples.page.length < 200) {
    throw new Error("READ_DURING_BUILD_PAGE_SAMPLE_INSUFFICIENT");
  }
  const page = branch(samples.page, samples.pageObservedBuildRequests, 300);
  const resource = branch(
    samples.resource,
    samples.resourceObservedBuildRequests,
    300,
  );
  const searchBranch = branch(
    samples.search,
    samples.searchObservedBuildRequests,
    1_000,
  );
  const search = Object.freeze({
    ...searchBranch,
    query_sha256: hashedInput(samples.normalQuery),
  });
  return Object.freeze({
    page,
    resource,
    schema_version: 1,
    search,
    status:
      page.status === "passed" &&
      resource.status === "passed" &&
      search.status === "passed"
        ? "passed"
        : "failed",
  });
}

interface RunnerInput {
  readonly bookKey: string;
  readonly concurrency: number;
  readonly databasePath: string;
  readonly normalQuery: string;
  readonly origin: string;
  readonly pagePath: string;
  readonly requests: number;
  readonly resourceMediaType: string;
  readonly resourcePath: string;
  readonly scheduleBookId?: number;
  readonly warmups: number;
}

function runningCandidate(database: Database.Database): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1 FROM jobs
         WHERE kind = 'build_book' AND state = 'running'
         LIMIT 1`,
      )
      .get(),
  );
}

async function waitForRunningCandidate(
  database: Database.Database,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (runningCandidate(database)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error("READ_DURING_BUILD_NOT_RUNNING");
}

function scheduleCandidate(database: Database.Database, bookId: number): void {
  const draft = database
    .prepare(
      `SELECT draft_import_id
       FROM books
       WHERE id = ? AND deletion_requested_at IS NULL`,
    )
    .get(bookId) as
    | {
        readonly draft_import_id: string | null;
      }
    | undefined;
  if (!draft?.draft_import_id) {
    throw new Error("READ_DURING_BUILD_DRAFT_MISSING");
  }
  new BuildRepository(database).createForDocument({
    bookId,
    sourceUpdatedAt: new DocumentRepository(database).timestamp(bookId),
    nowMs: Date.now(),
    importId: draft.draft_import_id,
  });
}

function routePath(value: string, label: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new Error(`${label}_INVALID`);
  }
  return value;
}

async function warmup(input: {
  readonly expectedContentType: string;
  readonly origin: URL;
  readonly path: string;
  readonly requests: number;
}): Promise<void> {
  for (let index = 0; index < input.requests; index += 1) {
    const url = new URL(input.path, input.origin);
    url.searchParams.set("benchmark_warmup", String(index));
    await timedFetch({ expectedContentType: input.expectedContentType, url });
  }
}

export async function benchmarkReadDuringBuild(
  input: RunnerInput,
): Promise<ReadDuringBuildReport> {
  const origin = new URL(input.origin);
  if (!["http:", "https:"].includes(origin.protocol)) {
    throw new Error("READ_DURING_BUILD_ORIGIN_INVALID");
  }
  if (!/^(?:[1-9][0-9]*|[a-z0-9]+(?:-[a-z0-9]+)*)$/u.test(input.bookKey)) {
    throw new Error("READ_DURING_BUILD_BOOK_KEY_INVALID");
  }
  if ([...input.normalQuery].length < 3) {
    throw new Error("READ_DURING_BUILD_QUERY_INVALID");
  }
  const pagePath = routePath(input.pagePath, "READ_DURING_BUILD_PAGE_PATH");
  const resourcePath = routePath(
    input.resourcePath,
    "READ_DURING_BUILD_RESOURCE_PATH",
  );
  const searchPath = `/api/books/${encodeURIComponent(input.bookKey)}/search`;
  await Promise.all([
    warmup({
      expectedContentType: "text/html",
      origin,
      path: pagePath,
      requests: input.warmups,
    }),
    warmup({
      expectedContentType: input.resourceMediaType,
      origin,
      path: resourcePath,
      requests: input.warmups,
    }),
  ]);

  const database = new Database(input.databasePath, {
    fileMustExist: true,
    readonly: input.scheduleBookId === undefined,
  });
  const observed = { page: 0, resource: 0, search: 0 };
  const request =
    (
      kind: keyof typeof observed,
      path: string,
      expectedContentType: string,
      inspect: (response: Response) => Promise<void> | void,
    ) =>
    async (index: number): Promise<number> => {
      if (runningCandidate(database)) observed[kind] += 1;
      const url = new URL(path, origin);
      url.searchParams.set("benchmark_request", String(index));
      if (kind === "search") url.searchParams.set("q", input.normalQuery);
      return timedFetch({ expectedContentType, inspect, url });
    };

  try {
    if (input.scheduleBookId !== undefined) {
      scheduleCandidate(database, input.scheduleBookId);
    }
    await waitForRunningCandidate(database);
    const [page, resource, search] = await Promise.all([
      runConcurrentRequests({
        concurrency: input.concurrency,
        request: request("page", pagePath, "text/html", (response) => {
          if (
            response.headers.get("cache-control") !==
            "public, max-age=0, must-revalidate"
          ) {
            throw new Error("READ_DURING_BUILD_PAGE_CACHE_INVALID");
          }
        }),
        requests: input.requests,
      }),
      runConcurrentRequests({
        concurrency: input.concurrency,
        request: request(
          "resource",
          resourcePath,
          input.resourceMediaType,
          (response) => {
            if (
              response.headers.get("cache-control") !==
              "private, max-age=31536000, immutable"
            ) {
              throw new Error("READ_DURING_BUILD_RESOURCE_CACHE_INVALID");
            }
          },
        ),
        requests: input.requests,
      }),
      runConcurrentRequests({
        concurrency: input.concurrency,
        request: request(
          "search",
          searchPath,
          "application/json",
          async (response) => {
            if (
              response.headers.get("cache-control") !==
              "public, max-age=0, must-revalidate"
            ) {
              throw new Error("READ_DURING_BUILD_SEARCH_CACHE_INVALID");
            }
            const body = (await response.clone().json()) as {
              readonly scope?: unknown;
            };
            if (body.scope !== "metadata_heading_body") {
              throw new Error("READ_DURING_BUILD_SEARCH_SCOPE_INVALID");
            }
          },
        ),
        requests: input.requests,
      }),
    ]);
    return buildReadDuringBuildReport({
      normalQuery: input.normalQuery,
      page,
      pageObservedBuildRequests: observed.page,
      resource,
      resourceObservedBuildRequests: observed.resource,
      search,
      searchObservedBuildRequests: observed.search,
    });
  } finally {
    database.close();
  }
}

function inputFromArguments(arguments_: readonly string[]): {
  readonly input: RunnerInput;
  readonly output: string;
} {
  const values = argumentMap(arguments_, [
    "--book-key",
    "--concurrency",
    "--database",
    "--normal-query",
    "--origin",
    "--output",
    "--page-path",
    "--requests",
    "--resource-media-type",
    "--resource-path",
    "--schedule-book-id",
    "--warmups",
  ]);
  return Object.freeze({
    input: Object.freeze({
      bookKey: requiredArgument(values, "--book-key"),
      concurrency: boundedInteger(
        values.get("--concurrency"),
        16,
        "concurrency",
        1,
        128,
      ),
      databasePath: resolve(requiredArgument(values, "--database")),
      normalQuery: requiredArgument(values, "--normal-query"),
      origin: requiredArgument(values, "--origin"),
      pagePath: requiredArgument(values, "--page-path"),
      requests: boundedInteger(
        values.get("--requests"),
        200,
        "requests",
        200,
        100_000,
      ),
      resourceMediaType: requiredArgument(values, "--resource-media-type"),
      resourcePath: requiredArgument(values, "--resource-path"),
      ...(values.get("--schedule-book-id")
        ? {
            scheduleBookId: boundedInteger(
              values.get("--schedule-book-id"),
              1,
              "schedule book ID",
              1,
              Number.MAX_SAFE_INTEGER,
            ),
          }
        : {}),
      warmups: boundedInteger(values.get("--warmups"), 5, "warmups", 0, 100),
    }),
    output: resolve(requiredArgument(values, "--output")),
  });
}

async function main(): Promise<void> {
  const { input, output } = inputFromArguments(process.argv.slice(2));
  const report = await benchmarkReadDuringBuild(input);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  await mkdir(dirname(output), { mode: 0o700, recursive: true });
  await writeFile(output, json, { mode: 0o600 });
  process.stdout.write(json);
  if (report.status !== "passed") process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "READ_DURING_BUILD_FAILED"}\n`,
    );
    process.exitCode = 1;
  });
}
