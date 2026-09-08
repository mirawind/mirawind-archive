import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import {
  argumentMap,
  boundedInteger,
  requiredArgument,
  runConcurrentRequests,
  summarizeLatencies,
  timedFetch,
} from "./http.js";

export interface ReadBenchmarkInput {
  readonly concurrency: number;
  readonly databasePath?: string;
  readonly mode: "concurrent-build" | "idle";
  readonly origin: string;
  readonly path: string;
  readonly requests: number;
  readonly warmups: number;
}

function runningBuild(database: Database.Database): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1 FROM jobs
         WHERE state = 'running'
           AND kind IN (
             'analyze_import', 'prepare_draft',
             'build_book'
           )
         LIMIT 1`,
      )
      .get(),
  );
}

export async function benchmarkReads(
  input: ReadBenchmarkInput,
): Promise<Readonly<Record<string, unknown>>> {
  const origin = new URL(input.origin);
  if (!["http:", "https:"].includes(origin.protocol)) {
    throw new Error("READ_BENCHMARK_ORIGIN_INVALID");
  }
  if (!input.path.startsWith("/") || input.path.startsWith("//")) {
    throw new Error("READ_BENCHMARK_PATH_INVALID");
  }
  if (input.mode === "concurrent-build" && !input.databasePath) {
    throw new Error("READ_BENCHMARK_DATABASE_REQUIRED");
  }
  const database = input.databasePath
    ? new Database(input.databasePath, {
        fileMustExist: true,
        readonly: true,
      })
    : null;
  let observedRunningBuild = false;
  try {
    const request = async (index: number): Promise<number> => {
      if (database && runningBuild(database)) observedRunningBuild = true;
      const url = new URL(input.path, origin);
      url.searchParams.set("benchmark_request", String(index));
      return timedFetch({
        expectedContentType: "text/html",
        inspect(response) {
          if (
            response.headers.get("cache-control") !==
            "public, max-age=0, must-revalidate"
          ) {
            throw new Error("READ_BENCHMARK_CACHE_POLICY_INVALID");
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
    if (input.mode === "concurrent-build" && !observedRunningBuild) {
      throw new Error("READ_BENCHMARK_BUILD_NOT_OBSERVED");
    }
    if (input.mode === "idle" && observedRunningBuild) {
      throw new Error("READ_BENCHMARK_IDLE_BUILD_OBSERVED");
    }
    const summary = summarizeLatencies(latencies);
    return Object.freeze({
      concurrency: input.concurrency,
      mode: input.mode,
      observed_running_build: observedRunningBuild,
      requests: input.requests,
      route: input.path,
      schema_version: 1,
      status: summary.p95_ms <= 300 ? "passed" : "failed",
      summary,
      target_p95_ms: 300,
      warmups: input.warmups,
    });
  } finally {
    database?.close();
  }
}

function inputFromArguments(arguments_: readonly string[]): {
  readonly input: ReadBenchmarkInput;
  readonly output: string | null;
} {
  const values = argumentMap(arguments_, [
    "--concurrency",
    "--database",
    "--mode",
    "--origin",
    "--output",
    "--path",
    "--requests",
    "--warmups",
  ]);
  const mode = values.get("--mode") ?? "idle";
  if (mode !== "idle" && mode !== "concurrent-build") {
    throw new Error("--mode must be idle or concurrent-build");
  }
  const database = values.get("--database");
  return Object.freeze({
    input: Object.freeze({
      concurrency: boundedInteger(
        values.get("--concurrency"),
        8,
        "concurrency",
        1,
        128,
      ),
      ...(database ? { databasePath: resolve(database) } : {}),
      mode,
      origin: requiredArgument(values, "--origin"),
      path: requiredArgument(values, "--path"),
      requests: boundedInteger(
        values.get("--requests"),
        200,
        "requests",
        20,
        100_000,
      ),
      warmups: boundedInteger(
        values.get("--warmups"),
        20,
        "warmups",
        0,
        10_000,
      ),
    }),
    output: values.get("--output")
      ? resolve(String(values.get("--output")))
      : null,
  });
}

async function main(): Promise<void> {
  const { input, output } = inputFromArguments(process.argv.slice(2));
  const report = await benchmarkReads(input);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) {
    await mkdir(dirname(output), { mode: 0o700, recursive: true });
    await writeFile(output, json, { mode: 0o600 });
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
      `${error instanceof Error ? error.message : "READ_BENCHMARK_FAILED"}\n`,
    );
    process.exitCode = 1;
  });
}
