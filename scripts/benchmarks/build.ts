import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";

import { SqliteBookAccessRepository } from "@/modules/catalog/adapters/sqlite/book-access";
import { setBookAccess } from "@/modules/catalog/application/commands/set-book-access";
import { applyMigrations } from "../../src/platform/sqlite/migrate.js";
import { loadMigrationManifest } from "../../src/platform/sqlite/migration-manifest.js";
import { openDatabase } from "../../src/platform/sqlite/connection.js";
import { BuildPublicationRepository } from "../../src/modules/publishing/adapters/sqlite/build-publication.js";
import { BuildRepository } from "../../src/modules/publishing/adapters/sqlite/builds.js";
import { DraftRepository } from "../../src/modules/publishing/adapters/sqlite/drafts.js";
import { ImportRepository } from "../../src/modules/publishing/adapters/sqlite/imports.js";
import {
  JobRepository,
  type JobRecord,
} from "../../src/modules/publishing/adapters/sqlite/jobs.js";
import { ImportUploadService } from "../../src/modules/publishing/adapters/filesystem/import-upload.js";
import {
  m1ImportExpiryMs,
  m1PublishPolicy,
  publishBuild,
} from "../../src/modules/publishing/application/publishing-api.js";
import { createStorageLayout } from "../../src/platform/filesystem/storage-layout.js";
import { parsePipelineProfileArtifact } from "../../src/observability/pipeline-profile.js";
import { sampleProcessTreeRss } from "../../src/platform/process/process-tree-rss.js";
import {
  verifyRealMineruFixtures,
  type VerifiedRealFixture,
} from "../fixtures/verify-real-mineru.js";
import {
  buildStressBook,
  type StressBookOptions,
} from "../fixtures/build-stress-book.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const workerEntry = join(repositoryRoot, "dist/processes/worker/index.js");
const pollIntervalMs = 100;
const perFixtureTimeoutMs = 30 * 60 * 1_000;

export interface BenchmarkFixture {
  readonly id: string;
  readonly mineruVersion: "3.4.4" | "synthetic";
  readonly pageCountRange: {
    readonly maximum: number;
    readonly minimum: number;
  };
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly type: "real" | "synthetic";
}

export interface BuildArguments {
  readonly cpuProfileDirectory?: string | null;
  readonly fixtureIds?: readonly string[];
  readonly includeStress?: boolean;
  readonly output: string | null;
  readonly onResult?: (input: {
    readonly completed: number;
    readonly fixtureId: string;
    readonly status: string;
    readonly total: number;
  }) => void;
  readonly profileDirectory?: string | null;
  readonly realDirectory: string | null;
  readonly realManifest: string | null;
  readonly repetitions?: number;
  readonly retainDirectory: string | null;
  readonly stress: StressBookOptions;
}

interface ManagedWorker {
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly stop: () => Promise<void>;
  readonly waitUntilReady: () => Promise<void>;
}

interface MemoryObservation {
  readonly peakProcessTreeRssBytes: number;
  readonly samples: number;
}

interface BenchmarkFixtureOptions {
  readonly cpuProfileDirectory?: string;
  readonly profileDirectory?: string;
  readonly repetition: number;
  readonly retainedDataRoot?: string;
}

function integerArgument(
  value: string | undefined,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${label} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return parsed;
}

function booleanArgument(
  value: string | undefined,
  fallback: boolean,
  label: string,
): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} must be true or false`);
}

function fixtureIdsArgument(value: string | undefined): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  const values = value.split(",").map((item) => item.trim());
  if (
    values.length < 1 ||
    values.length > 100 ||
    values.some((item) => !/^real-mineru-[a-z0-9]{6,32}$/u.test(item)) ||
    new Set(values).size !== values.length
  ) {
    throw new Error("fixture IDs must be unique opaque IDs");
  }
  return Object.freeze(values);
}

export function parseBuildArguments(
  arguments_: readonly string[],
): BuildArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith("--") || !value) {
      throw new Error("Benchmark arguments must be --name value pairs");
    }
    if (values.has(name)) throw new Error(`Duplicate argument: ${name}`);
    values.set(name, value);
  }
  for (const name of values.keys()) {
    if (
      ![
        "--output",
        "--cpu-profile-dir",
        "--fixture-ids",
        "--include-stress",
        "--profile-dir",
        "--real-dir",
        "--real-manifest",
        "--repetitions",
        "--retain-dir",
        "--stress-blocks",
        "--stress-images",
        "--stress-pages",
      ].includes(name)
    ) {
      throw new Error(`Unknown argument: ${name}`);
    }
  }
  return Object.freeze({
    cpuProfileDirectory: values.get("--cpu-profile-dir")
      ? resolve(String(values.get("--cpu-profile-dir")))
      : null,
    fixtureIds: fixtureIdsArgument(values.get("--fixture-ids")),
    includeStress: booleanArgument(
      values.get("--include-stress"),
      true,
      "include stress",
    ),
    output: values.get("--output")
      ? resolve(String(values.get("--output")))
      : null,
    profileDirectory: values.get("--profile-dir")
      ? resolve(String(values.get("--profile-dir")))
      : null,
    realDirectory: values.get("--real-dir")
      ? resolve(String(values.get("--real-dir")))
      : null,
    realManifest: values.get("--real-manifest") ?? null,
    repetitions: integerArgument(
      values.get("--repetitions"),
      1,
      "repetitions",
      1,
      10,
    ),
    retainDirectory: values.get("--retain-dir")
      ? resolve(String(values.get("--retain-dir")))
      : null,
    stress: Object.freeze({
      blocksPerPage: integerArgument(
        values.get("--stress-blocks"),
        20,
        "stress blocks",
        1,
        100,
      ),
      imageCount: integerArgument(
        values.get("--stress-images"),
        32,
        "stress images",
        0,
        500,
      ),
      pages: integerArgument(
        values.get("--stress-pages"),
        500,
        "stress pages",
        1,
        2_000,
      ),
    }),
  });
}

function safeFailureCode(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as Readonly<Record<string, unknown>>).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{2,79}$/u.test(code)) {
      return code;
    }
  }
  if (error instanceof RangeError) return "BUILD_RANGE_LIMIT_EXCEEDED";
  const message = error instanceof Error ? error.message : "";
  const match = /\b[A-Z][A-Z0-9_]{2,79}\b/u.exec(message);
  return match?.[0] ?? "BENCHMARK_FIXTURE_FAILED";
}

function safeFailureEvidence(
  error: unknown,
): Readonly<Record<string, unknown>> {
  if (!error || typeof error !== "object") return Object.freeze({});
  const diagnostics = (error as Readonly<Record<string, unknown>>).diagnostics;
  if (!Array.isArray(diagnostics)) return Object.freeze({});
  const codes = diagnostics.flatMap((diagnostic) => {
    if (!diagnostic || typeof diagnostic !== "object") return [];
    const code = (diagnostic as Readonly<Record<string, unknown>>).code;
    return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,79}$/u.test(code)
      ? [code]
      : [];
  });
  return Object.freeze({
    diagnostic_codes: Object.freeze([...new Set(codes)].slice(0, 20)),
    diagnostic_count: diagnostics.length,
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function roundedMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

async function removeBenchmarkTree(path: string): Promise<void> {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata) return;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("BENCHMARK_DATA_ROOT_INVALID");
  }
  const unlock = async (directory: string): Promise<void> => {
    await chmod(directory, 0o700);
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => unlock(join(directory, entry.name))),
    );
  };
  await unlock(path);
  await rm(path, { force: true, recursive: true });
}

async function waitFor<T>(
  inspect: () => T | null,
  deadlineMs: number,
  label: string,
): Promise<T> {
  while (Date.now() < deadlineMs) {
    const result = inspect();
    if (result !== null) return result;
    await delay(pollIntervalMs);
  }
  throw new Error(
    `${label.toUpperCase().replaceAll(/[^A-Z0-9]+/gu, "_")}_TIMEOUT`,
  );
}

class BenchmarkJobFailure extends Error {
  readonly job: JobRecord;

  constructor(job: JobRecord) {
    super(job.errorCode ?? "BENCHMARK_JOB_FAILED");
    this.name = "BenchmarkJobFailure";
    this.job = job;
  }
}

function terminalFailure(job: JobRecord): BenchmarkJobFailure {
  return new BenchmarkJobFailure(job);
}

async function waitForJob(
  jobs: JobRepository,
  jobId: string,
  deadlineMs: number,
): Promise<JobRecord> {
  return waitFor(
    () => {
      const job = jobs.get(jobId);
      if (!job) throw new Error("BENCHMARK_JOB_MISSING");
      if (
        job.state === "failed" ||
        job.state === "canceled" ||
        job.state === "interrupted"
      ) {
        throw terminalFailure(job);
      }
      return job.state === "succeeded" ? job : null;
    },
    deadlineMs,
    `job ${jobId}`,
  );
}

function startWorker(
  dataRoot: string,
  profileDirectory?: string,
  cpuProfileDirectory?: string,
): ManagedWorker {
  const child = spawn(process.execPath, [workerEntry], {
    cwd: repositoryRoot,
    detached: true,
    env: {
      ...process.env,
      MIRAWIND_ALLOWED_HOSTS: "benchmark.invalid",
      MIRAWIND_AUTH_SECRET: "benchmark-only-secret-0123456789-abcdef",
      MIRAWIND_DATA_DIR: dataRoot,
      MIRAWIND_PASSKEY_RP_ID: "benchmark.invalid",
      MIRAWIND_PUBLIC_ORIGIN: "https://benchmark.invalid",
      ...(profileDirectory
        ? { MIRAWIND_PIPELINE_PROFILE_DIR: profileDirectory }
        : {}),
      ...(cpuProfileDirectory
        ? { MIRAWIND_PIPELINE_CPU_PROFILE_DIR: cpuProfileDirectory }
        : {}),
      NODE_ENV: "production",
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let exited = false;
  const maximumOutput = 64 * 1024;
  const append = (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-maximumOutput);
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
    async waitUntilReady() {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (output.includes("Mirawind worker ready")) return;
        if (exited) throw new Error("BENCHMARK_WORKER_EXITED");
        await delay(25);
      }
      throw new Error("BENCHMARK_WORKER_READY_TIMEOUT");
    },
  });
}

async function monitorMemory(
  rootPid: number,
  signal: AbortSignal,
): Promise<MemoryObservation> {
  let peakProcessTreeRssBytes: number | null = null;
  let samples = 0;
  while (!signal.aborted) {
    const sample = await sampleProcessTreeRss(rootPid);
    if (sample.status === "available") {
      peakProcessTreeRssBytes = Math.max(
        peakProcessTreeRssBytes ?? 0,
        sample.rssBytes,
      );
      samples += 1;
    }
    await delay(25);
  }
  if (peakProcessTreeRssBytes === null) {
    throw new Error("BENCHMARK_PROCESS_TREE_RSS_UNAVAILABLE");
  }
  return Object.freeze({ peakProcessTreeRssBytes, samples });
}

function idempotencyKey(prefix: string, fixture: BenchmarkFixture): string {
  return `${prefix}-${fixture.sha256}`;
}

function jobDuration(job: JobRecord): number | null {
  return job.startedAtMs !== null && job.finishedAtMs !== null
    ? job.finishedAtMs - job.startedAtMs
    : null;
}

function jobRows(
  database: Database.Database,
  importId: string,
  bookId: number,
): readonly JobRecord[] {
  return new JobRepository(database)
    .listRecent(100)
    .filter((job) => job.importId === importId || job.bookId === bookId)
    .sort((left, right) => left.createdAtMs - right.createdAtMs);
}

async function pipelineProfiles(
  directory: string | undefined,
  jobs: readonly JobRecord[],
): Promise<Readonly<Record<string, Readonly<Record<string, unknown>>>>> {
  if (!directory) return Object.freeze({});
  const entries = await Promise.all(
    jobs.map(async (job) => {
      const path = join(directory, `${job.id}.json`);
      const bytes = await readFile(path);
      if (bytes.byteLength > 1024 * 1024) {
        throw new Error("PIPELINE_PROFILE_SIZE_LIMIT");
      }
      const profile = parsePipelineProfileArtifact(
        JSON.parse(bytes.toString("utf8")) as unknown,
      );
      const { job_id: profileJobId, ...sanitized } = profile;
      if (profileJobId !== job.id || profile.job_kind !== job.kind) {
        throw new Error("PIPELINE_PROFILE_JOB_MISMATCH");
      }
      const databaseDurationMs = jobDuration(job);
      return [
        `${job.kind}:${job.attempt}`,
        Object.freeze({
          ...sanitized,
          database_job_duration_ms: databaseDurationMs,
          parent_finalize_and_ipc_ms:
            databaseDurationMs === null
              ? null
              : roundedMilliseconds(
                  Math.max(0, databaseDurationMs - profile.duration_ms),
                ),
        }),
      ] as const;
    }),
  );
  return Object.freeze(Object.fromEntries(entries));
}

function indexStorageBytes(database: Database.Database): number | null {
  try {
    const result = database
      .prepare(
        `SELECT COALESCE(SUM(pgsize), 0) AS bytes
         FROM dbstat
         WHERE name LIKE 'search_fts%'
            OR name LIKE 'search_short%'`,
      )
      .get() as { bytes: number };
    return result.bytes;
  } catch {
    return null;
  }
}

async function benchmarkFixture(
  fixture: BenchmarkFixture,
  options: BenchmarkFixtureOptions,
): Promise<Readonly<Record<string, unknown>>> {
  if (process.platform !== "linux") {
    throw new Error("BENCHMARK_REQUIRES_LINUX_PROCFS");
  }
  const dataRoot =
    options.retainedDataRoot ??
    (await mkdtemp(join(tmpdir(), "mirawind-build-benchmark-")));
  if (options.retainedDataRoot) {
    await removeBenchmarkTree(dataRoot);
    await mkdir(dataRoot, { mode: 0o700, recursive: true });
  }
  const startedAt = performance.now();
  let worker: ManagedWorker | null = null;
  let memoryController: AbortController | null = null;
  let memoryPromise: Promise<MemoryObservation> | null = null;
  const layout = await createStorageLayout(dataRoot);
  const databasePath = join(layout.databaseDirectory, "mirawind.sqlite");
  const database = openDatabase(databasePath, { role: "worker" });
  try {
    applyMigrations(database, await loadMigrationManifest());
    const uploadStartedAt = performance.now();
    const upload = await new ImportUploadService(database, layout).store({
      bytes: createReadStream(fixture.path),
      expiresAtMs: m1ImportExpiryMs,
      idempotencyKey: idempotencyKey("benchmark-upload", fixture),
      originalName: basename(fixture.path),
    });
    const uploadMs =
      Math.round((performance.now() - uploadStartedAt) * 1_000) / 1_000;
    const acceptedAt = performance.now();

    const fixtureProfileDirectory = options.profileDirectory
      ? join(
          options.profileDirectory,
          fixture.id,
          `run-${String(options.repetition).padStart(3, "0")}`,
        )
      : undefined;
    const fixtureCpuProfileDirectory = options.cpuProfileDirectory
      ? join(
          options.cpuProfileDirectory,
          fixture.id,
          `run-${String(options.repetition).padStart(3, "0")}`,
        )
      : undefined;
    worker = startWorker(
      dataRoot,
      fixtureProfileDirectory,
      fixtureCpuProfileDirectory,
    );
    if (!worker.child.pid) throw new Error("BENCHMARK_WORKER_PID_MISSING");
    memoryController = new AbortController();
    memoryPromise = monitorMemory(worker.child.pid, memoryController.signal);
    await worker.waitUntilReady();

    const deadline = Date.now() + perFixtureTimeoutMs;
    const jobs = new JobRepository(database);
    const imports = new ImportRepository(database);
    await waitForJob(jobs, upload.job.id, deadline);
    const imported = await waitFor(
      () => {
        const current = imports.require(upload.import.id);
        const latest = jobs.latestForImport(current.id);
        if (
          latest &&
          ["failed", "canceled", "interrupted"].includes(latest.state)
        ) {
          throw terminalFailure(latest);
        }
        if (current.state === "rejected") {
          throw new Error(current.safeErrorCode ?? "BENCHMARK_IMPORT_REJECTED");
        }
        return current.state === "draft_ready" ? current : null;
      },
      deadline,
      `fixture ${fixture.id} draft`,
    );
    if (imported.bookId === null) throw new Error("BENCHMARK_BOOK_ID_MISSING");

    const drafts = new DraftRepository(database);
    const candidates = new BuildRepository(database);
    const candidate = await waitFor(
      () => {
        const current = candidates.findCurrent(imported.bookId as number);
        if (current?.state === "ready" && current.id) return current;
        if (
          current &&
          ["failed", "canceled", "interrupted"].includes(current.state)
        )
          throw new Error(current.safeErrorCode ?? "BENCHMARK_BUILD_FAILED");
        const candidateJob = current ? jobs.get(current.jobId) : null;
        if (
          candidateJob &&
          ["failed", "canceled", "interrupted"].includes(candidateJob.state)
        )
          throw terminalFailure(candidateJob);
        return null;
      },
      deadline,
      `fixture ${fixture.id} candidate`,
    );
    const book = drafts.requireBook(imported.bookId);
    if (!book.draftImportId || !candidate.id) {
      throw new Error("BENCHMARK_DRAFT_CAPTURE_MISSING");
    }
    const previewReadyAt = performance.now();

    const publishRequestedAt = performance.now();
    await publishBuild({
      actorUserId: null,
      bookId: book.id,
      expectedUpdatedAt: candidate.sourceUpdatedAt,
      buildId: candidate.id,
      nowMs: Date.now(),
      policy: m1PublishPolicy,
      publication: new BuildPublicationRepository(database),
    });
    setBookAccess({
      access: "public",
      actorUserId: null,
      bookId: book.id,
      books: new SqliteBookAccessRepository(database),
      nowMs: Date.now(),
    });
    const current = drafts.requireBook(book.id);
    if (!current.currentVersionId || current.access !== "public") {
      throw new Error("BENCHMARK_PUBLICATION_MISSING");
    }
    const publicReadyAt = performance.now();
    const version = database
      .prepare(
        `SELECT version_rel_path FROM book_versions
         WHERE id = ? AND state = 'published'`,
      )
      .get(current.currentVersionId) as
      { version_rel_path: string } | undefined;
    if (!version) throw new Error("BENCHMARK_VERSION_ROW_MISSING");
    const manifest = JSON.parse(
      await readFile(
        join(layout.root, version.version_rel_path, "document-manifest.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const databaseSize = (await stat(databasePath)).size;
    const walSize = await stat(`${databasePath}-wal`)
      .then((value) => value.size)
      .catch(() => 0);
    const jobsForFixture = jobRows(database, imported.id, book.id);

    memoryController.abort();
    const memory = await memoryPromise;
    memoryPromise = null;
    const analyze = jobsForFixture.find((job) => job.kind === "analyze_import");
    const phases = Object.fromEntries(
      jobsForFixture.map((job) => [
        `${job.kind}:${job.attempt}`,
        {
          duration_ms: jobDuration(job),
          state: job.state,
        },
      ]),
    );
    const profiles = await pipelineProfiles(
      fixtureProfileDirectory,
      jobsForFixture,
    );
    const wallMs = Math.round((performance.now() - startedAt) * 1_000) / 1_000;

    return Object.freeze({
      archive: {
        compressed_bytes: fixture.sizeBytes,
        entries:
          analyze?.progress.unit === "items"
            ? analyze.progress.completed
            : null,
        extracted_bytes: analyze?.progress.processed_bytes ?? null,
        files: null,
        sha256: fixture.sha256,
      },
      compiler_output: {
        blocks: Object.keys(
          (manifest.blocks as Record<string, unknown> | undefined) ?? {},
        ).length,
        bytes: null,
        files: null,
        pages: Array.isArray(manifest.pages) ? manifest.pages.length : null,
        resources: Object.keys(
          (manifest.resources as Record<string, unknown> | undefined) ?? {},
        ).length,
      },
      database: {
        file_bytes: databaseSize,
        index_storage_bytes: indexStorageBytes(database),
        wal_bytes: walSize,
      },
      fixture_id: fixture.id,
      fixture_type: fixture.type,
      fts: {
        build_ms: null,
        rows: null,
        short_rows: null,
        spool_bytes: null,
      },
      memory: {
        peak_process_tree_rss_bytes: memory.peakProcessTreeRssBytes,
        sample_interval_ms: 25,
        samples: memory.samples,
      },
      mineru_version: fixture.mineruVersion,
      page_count_range: fixture.pageCountRange,
      phases,
      pipeline_profiles: profiles,
      repetition: options.repetition,
      status: "passed",
      timings: {
        accepted_to_preview_ms: roundedMilliseconds(
          previewReadyAt - acceptedAt,
        ),
        publish_requested_to_public_ms: roundedMilliseconds(
          publicReadyAt - publishRequestedAt,
        ),
        upload_ms: uploadMs,
        wall_ms: wallMs,
      },
      version_id: current.currentVersionId,
    });
  } catch (error) {
    const failedJob =
      error instanceof BenchmarkJobFailure ? error.job : undefined;
    return Object.freeze({
      error_class: failedJob?.errorClass ?? null,
      error_code: failedJob?.errorCode ?? safeFailureCode(error),
      ...(failedJob ? {} : safeFailureEvidence(error)),
      failed_job_kind: failedJob?.kind ?? null,
      failed_job_phase: failedJob?.phase ?? null,
      fixture_id: fixture.id,
      fixture_type: fixture.type,
      mineru_version: fixture.mineruVersion,
      repetition: options.repetition,
      status: "failed",
    });
  } finally {
    memoryController?.abort();
    if (memoryPromise) await memoryPromise.catch(() => undefined);
    await worker?.stop();
    database.close();
    if (!options.retainedDataRoot) await removeBenchmarkTree(dataRoot);
  }
}

function realFixture(
  directory: string,
  fixture: VerifiedRealFixture,
): BenchmarkFixture {
  return Object.freeze({
    id: fixture.id,
    mineruVersion: fixture.mineruVersion as "3.4.4",
    pageCountRange: fixture.pageCountRange,
    path: join(directory, fixture.fileName),
    sha256: fixture.sha256,
    sizeBytes: fixture.sizeBytes,
    type: "real",
  });
}

export async function resolveBenchmarkFixtures(
  input: BuildArguments,
  temporaryDirectory: string,
): Promise<readonly BenchmarkFixture[]> {
  const result: BenchmarkFixture[] = [];
  if (input.realDirectory) {
    const selectedIds = input.fixtureIds ?? [];
    const verified = await verifyRealMineruFixtures(
      input.realDirectory,
      input.realManifest ?? undefined,
      selectedIds.length > 0 ? selectedIds : undefined,
    );
    result.push(
      ...verified.map((fixture) =>
        realFixture(input.realDirectory as string, fixture),
      ),
    );
  }
  if (input.includeStress ?? true) {
    const stress = buildStressBook(input.stress);
    const stressPath = join(temporaryDirectory, "synthetic-stress.zip");
    await writeFile(stressPath, stress.bytes, { mode: 0o600 });
    result.push(
      Object.freeze({
        id: "synthetic-stress-v1",
        mineruVersion: "synthetic",
        pageCountRange: {
          maximum: stress.metadata.pages,
          minimum: stress.metadata.pages,
        },
        path: stressPath,
        sha256: stress.metadata.sha256,
        sizeBytes: stress.metadata.size_bytes,
        type: "synthetic",
      }),
    );
  }
  if (result.length === 0) throw new Error("BENCHMARK_FIXTURE_SET_EMPTY");
  return Object.freeze(result);
}

export async function runBuildBenchmarks(
  input: BuildArguments,
): Promise<Readonly<Record<string, unknown>>> {
  await access(workerEntry);
  if (input.retainDirectory) {
    await mkdir(input.retainDirectory, { mode: 0o700, recursive: true });
  }
  if (input.profileDirectory) {
    await mkdir(input.profileDirectory, { mode: 0o700, recursive: true });
  }
  if (input.cpuProfileDirectory) {
    await mkdir(input.cpuProfileDirectory, { mode: 0o700, recursive: true });
  }
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "mirawind-benchmark-fixtures-"),
  );
  try {
    const selected = await resolveBenchmarkFixtures(input, temporaryDirectory);
    const results: Readonly<Record<string, unknown>>[] = [];
    let failed = false;
    const repetitions = input.repetitions ?? 1;
    for (const fixture of selected) {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        try {
          const retainedDataRoot = input.retainDirectory
            ? join(
                input.retainDirectory,
                fixture.id,
                `run-${String(repetition).padStart(3, "0")}`,
              )
            : undefined;
          const profileRunDirectory = input.profileDirectory
            ? join(
                input.profileDirectory,
                fixture.id,
                `run-${String(repetition).padStart(3, "0")}`,
              )
            : undefined;
          const cpuProfileRunDirectory = input.cpuProfileDirectory
            ? join(
                input.cpuProfileDirectory,
                fixture.id,
                `run-${String(repetition).padStart(3, "0")}`,
              )
            : undefined;
          if (profileRunDirectory) {
            await removeBenchmarkTree(profileRunDirectory);
          }
          if (cpuProfileRunDirectory) {
            await removeBenchmarkTree(cpuProfileRunDirectory);
          }
          const result = await benchmarkFixture(fixture, {
            ...(input.cpuProfileDirectory
              ? { cpuProfileDirectory: input.cpuProfileDirectory }
              : {}),
            ...(input.profileDirectory
              ? { profileDirectory: input.profileDirectory }
              : {}),
            repetition,
            ...(retainedDataRoot ? { retainedDataRoot } : {}),
          });
          if (result.status !== "passed") failed = true;
          results.push(result);
          input.onResult?.({
            completed: results.length,
            fixtureId: fixture.id,
            status: String(result.status),
            total: selected.length * repetitions,
          });
        } catch (error) {
          failed = true;
          const failure = Object.freeze({
            error_code: safeFailureCode(error),
            fixture_id: fixture.id,
            fixture_type: fixture.type,
            mineru_version: fixture.mineruVersion,
            repetition,
            status: "failed",
          });
          results.push(failure);
          input.onResult?.({
            completed: results.length,
            fixtureId: fixture.id,
            status: failure.status,
            total: selected.length * repetitions,
          });
        }
      }
    }
    return Object.freeze({
      build_mode: "candidate",
      captured_at: new Date().toISOString(),
      real_fixture_gate: input.realDirectory
        ? "required_and_verified"
        : "skipped",
      retained_data: input.retainDirectory !== null,
      results,
      schema_version: 1,
      status: failed ? "failed" : "passed",
      ...(input.profileDirectory
        ? { profile_version: "pipeline-profile-v1" }
        : {}),
      stress_configuration: {
        blocks_per_page: input.stress.blocksPerPage,
        image_count: input.stress.imageCount,
        pages: input.stress.pages,
      },
    });
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

async function main(): Promise<void> {
  const input = parseBuildArguments(process.argv.slice(2));
  const report = await runBuildBenchmarks(input);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (input.output) {
    await mkdir(dirname(input.output), { mode: 0o700, recursive: true });
    await writeFile(input.output, json, { mode: 0o600 });
  }
  process.stdout.write(json);
  if (report.status !== "passed") process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${safeFailureCode(error)}\n`);
    process.exitCode = 1;
  });
}
