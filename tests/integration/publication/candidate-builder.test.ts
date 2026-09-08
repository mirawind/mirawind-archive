import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";

import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { reconcileStorage } from "@/composition/storage-reconciliation";
import { BookPresentationRepository } from "@/modules/catalog/adapters/sqlite/book-presentations";
import { handleBuildCandidate } from "@/entrypoints/worker/handlers/build-candidate";
import type { JobProgressMessage } from "@/entrypoints/worker/protocol";
import { buildCandidateVersion } from "@/modules/publishing/adapters/filesystem/build-candidate-version";
import {
  CandidateRegistrationAdapter,
  type CandidateRegistrationCrashPoint,
} from "@/modules/publishing/adapters/sqlite/candidate-registration";
import { VersionRepository } from "@/modules/publishing/adapters/sqlite/versions";
import { serializeBookDocument } from "@/modules/publishing/core/content/book-document";
import type { CandidateTreeCrashPoint } from "@/modules/publishing/application/candidate-durability";
import {
  candidateBuildIdentities,
  finalizeCandidate,
  parseBuildCandidateCommand,
  type BuildCandidateCommand,
} from "@/modules/publishing/application/publishing-api";
import {
  validateDocumentManifest,
  validateVersionMarker,
} from "@/modules/publishing/core/publication/document-manifest-schema";

import {
  createTemporaryDataRoot,
  type TemporaryDataRoot,
} from "../../helpers/data-root.js";
import { openMigratedTestDatabase } from "../../helpers/database.js";
import {
  publicationTestLeaseOwner,
  setupPublicationFixture,
} from "../../helpers/publication.js";
import { smallBook, headingBlock, paragraphBlock } from "../../helpers/ir-book";

const bookId = 9;
const sourceUpdatedAt = 1000;
const createdAtMs = 1_753_315_200_000;
const headingIds = [
  "blk_candidate_builder_heading_0001",
  "blk_candidate_builder_heading_0002",
] as const;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function commandFor(suffix: string): BuildCandidateCommand {
  const candidateId = `candidate_candidate_builder_${suffix}`;
  return parseBuildCandidateCommand({
    bookId,
    candidateId,
    capturedCurrentVersionId: null,
    compilerIdentity: candidateBuildIdentities.compiler,
    inputRelativePath: `books/${bookId}/draft/candidates/${candidateId}/book.json`,
    documentSha256: "a".repeat(64),
    sourceUpdatedAt,
    jobId: `job_candidate_builder_${suffix}`,
    kind: "build_candidate",
    previewIdentity: candidateBuildIdentities.preview,
    readerIdentity: candidateBuildIdentities.reader,
    rendererIdentity: candidateBuildIdentities.renderer,
    importId: `imp_candidate_builder_${suffix}`,
    resourceRootRelativePath: `books/${bookId}`,
    versionId: `ver_candidate_builder_${suffix}`,
  });
}

async function writeCandidateInput(
  dataRoot: TemporaryDataRoot,
  command: Omit<BuildCandidateCommand, "documentSha256">,
  options: {
    readonly originalContents?: string;
    readonly originalSha256?: string;
    readonly resource?: {
      readonly contents: Uint8Array;
      readonly filename: string;
    };
  } = {},
): Promise<BuildCandidateCommand> {
  const document = smallBook(command.bookId, command.sourceUpdatedAt);
  document.metadata = {
    title: "Candidate Builder Fixture",
    authors: ["Fixture Author"],
    language: "en",
  };
  document.publishing.numbering = "generated";
  document.publishing.boundaries.body_start_block_id = headingIds[0];
  document.blocks = [
    { ...headingBlock("First chapter"), id: headingIds[0] },
    {
      ...paragraphBlock(""),
      content: [
        { type: "text", text: "Body with " },
        { type: "code", code: "code/path.ts" },
        { type: "text", text: " and " },
        { type: "math", latex: "x + y" },
      ],
    },
    { ...headingBlock("Second chapter"), id: headingIds[1] },
    paragraphBlock("Final body."),
  ];
  const sourceRoot = resolve(dataRoot.path, command.resourceRootRelativePath);
  const inputPath = resolve(dataRoot.path, command.inputRelativePath);
  const originalId = "file_candidate_builder_0001";
  const originalPath = resolve(
    dataRoot.layout.bookDirectory,
    String(command.bookId),
    "originals",
    originalId,
  );
  const originalContents = options.originalContents ?? "original ZIP";
  const originalFiles = [
    {
      filename: "original.zip",
      id: originalId,
      media_type: "application/zip",
      path: `originals/${originalId}`,
      role: "mineru_zip",
      sha256: options.originalSha256 ?? sha256(originalContents),
      size: Buffer.byteLength(originalContents),
    },
  ];
  await Promise.all([
    mkdir(sourceRoot, { mode: 0o700, recursive: true }),
    mkdir(resolve(inputPath, ".."), { mode: 0o700, recursive: true }),
  ]);
  const proof = [];
  if (options.resource) {
    const resourceId = "res_candidate_builder_image0001";
    const resourcePath = "assets/" + options.resource.filename;
    document.resources.push({
      id: resourceId,
      path: resourcePath,
      media_type: "image/png",
    });
    document.blocks.push({
      id: "blk_candidate_builder_image0001",
      type: "image",
      resource_id: resourceId,
      alt: "Fixture image",
    });
    proof.push({
      id: resourceId,
      sha256: sha256(options.resource.contents),
      size: options.resource.contents.byteLength,
    });
    await mkdir(resolve(sourceRoot, "assets"), { recursive: true });
    await writeFile(
      resolve(sourceRoot, resourcePath),
      options.resource.contents,
      { mode: 0o400 },
    );
  }
  const json = serializeBookDocument(document);
  await writeFile(inputPath, json, { mode: 0o400 });
  await writeFile(resolve(sourceRoot, "draft/book.json"), json, {
    mode: 0o600,
  });
  await writeFile(
    resolve(inputPath, "../resources.json"),
    JSON.stringify(proof),
  );
  await writeFile(
    resolve(inputPath, "../original.json"),
    JSON.stringify({ import_id: command.importId, files: originalFiles }),
  );
  await mkdir(resolve(originalPath, ".."), { mode: 0o700, recursive: true });
  await writeFile(originalPath, originalContents, { mode: 0o400 });
  return parseBuildCandidateCommand({
    ...command,
    documentSha256: sha256(json),
  });
}

function distinctPhases(
  messages: readonly JobProgressMessage[],
): readonly string[] {
  return messages
    .map((message) => message.phase)
    .filter((phase, index, phases) => phase !== phases[index - 1]);
}

async function registrationFixture(
  database: Database.Database,
  dataRoot: TemporaryDataRoot,
) {
  const fixture = setupPublicationFixture(database, { registerReady: false });
  const command = await writeCandidateInput(
    dataRoot,
    fixture.candidates.buildCommand(fixture.candidate.attemptId),
  );
  const artifact = await buildCandidateVersion({
    command,
    createdAtMs,
    layout: dataRoot.layout,
    preparationDiagnostics: [],
  });
  return { artifact, command, fixture };
}

describe("isolated candidate child builder", () => {
  it("builds one immutable preview/public candidate with bounded telemetry", async () => {
    const dataRoot = await createTemporaryDataRoot("candidate-builder");
    try {
      const command = await writeCandidateInput(
        dataRoot,
        commandFor("success_0001"),
      );
      const progress: JobProgressMessage[] = [];
      const artifact = await handleBuildCandidate({
        command,
        execute: ({ command: parsed, onStage, signal }) =>
          buildCandidateVersion({
            command: parsed,
            createdAtMs,
            layout: dataRoot.layout,
            onStage,
            preparationDiagnostics: [],
            ...(signal ? { signal } : {}),
          }),
        onProgress(message) {
          progress.push(message);
        },
      });

      const candidateDirectory = resolve(
        dataRoot.path,
        artifact.artifactRootRelativePath,
      );
      const [manifest, marker, candidateMetadata] = await Promise.all([
        readFile(
          resolve(candidateDirectory, "document-manifest.json"),
          "utf8",
        ).then((value) => validateDocumentManifest(JSON.parse(value))),
        readFile(resolve(candidateDirectory, "version.json"), "utf8").then(
          (value) => validateVersionMarker(JSON.parse(value)),
        ),
        readFile(
          resolve(candidateDirectory, "derived/candidate.json"),
          "utf8",
        ).then(
          (value) => JSON.parse(value) as Readonly<Record<string, unknown>>,
        ),
      ]);
      expect(artifact).toMatchObject({
        candidateId: command.candidateId,
        compilerIdentity: candidateBuildIdentities.compiler,
        pageCount: 2,
        previewIdentity: candidateBuildIdentities.preview,
        readerIdentity: candidateBuildIdentities.reader,
        rendererIdentity: candidateBuildIdentities.renderer,
        versionId: command.versionId,
      });
      expect(manifest.compiler).toMatchObject({
        renderer_version: command.rendererIdentity,
        version: command.compilerIdentity,
      });
      expect(marker.compiler).toMatchObject({
        renderer_version: command.rendererIdentity,
        version: command.compilerIdentity,
      });
      expect(candidateMetadata).toEqual({
        candidate_id: command.candidateId,
        compiler_identity: command.compilerIdentity,
        preview_identity: command.previewIdentity,
        reader_identity: command.readerIdentity,
        renderer_identity: command.rendererIdentity,
        semantic_digest: artifact.semanticDigest,
        version_id: command.versionId,
      });

      const preview = await readFile(
        resolve(candidateDirectory, "preview/pages/1.html"),
        "utf8",
      );
      expect(preview).toContain(
        `renderers/${command.rendererIdentity}/katex.css`,
      );
      expect(preview).toContain(`styles/${command.readerIdentity}.css`);

      const manifestLines = (
        await readFile(
          resolve(candidateDirectory, "derived/manifest-pages.ndjson"),
          "utf8",
        )
      )
        .trim()
        .split("\n");
      const searchLines = (
        await readFile(
          resolve(candidateDirectory, "derived/search-rows.ndjson"),
          "utf8",
        )
      )
        .trim()
        .split("\n");
      expect(manifestLines).toHaveLength(artifact.pageCount);
      expect(searchLines).toHaveLength(artifact.searchRowCount);
      const declaredFiles = (
        marker.files as readonly Readonly<Record<string, unknown>>[]
      ).map((file) => file.path);
      expect(declaredFiles).toEqual(
        expect.arrayContaining([
          "derived/candidate.json",
          "derived/manifest-pages.ndjson",
          "derived/search-rows.ndjson",
          "preview/diagnostics.json",
          "preview/pages/1.html",
          "published/pages/1.html",
          "published/styles/document.css",
        ]),
      );
      expect((await stat(candidateDirectory)).mode & 0o777).toBe(0o500);
      expect(
        (await stat(resolve(candidateDirectory, "preview/pages/1.html"))).mode &
          0o777,
      ).toBe(0o400);
      await expect(
        access(resolve(dataRoot.layout.temporaryDirectory, command.jobId)),
      ).rejects.toMatchObject({ code: "ENOENT" });

      expect(distinctPhases(progress)).toEqual([
        "compile_book",
        "render_pages",
        "build_search",
        "finalize_candidate",
      ]);
      for (const phase of distinctPhases(progress)) {
        const updates = progress.filter((message) => message.phase === phase);
        expect(updates.at(-1)?.progress.completed).toBe(
          updates.at(-1)?.progress.total,
        );
        for (let index = 1; index < updates.length; index += 1) {
          expect(updates[index]?.progress.completed).toBeGreaterThanOrEqual(
            updates[index - 1]?.progress.completed ?? 0,
          );
        }
      }
      expect(progress.every((message) => message.jobId === command.jobId)).toBe(
        true,
      );
      expect(JSON.stringify(artifact)).not.toContain(
        "Candidate Builder Fixture",
      );
      expect(JSON.stringify(artifact)).not.toContain(dataRoot.path);
    } finally {
      await dataRoot.cleanup();
    }
  });

  it("removes staging and never exposes a ready tree after cancellation", async () => {
    const dataRoot = await createTemporaryDataRoot("candidate-cancel");
    try {
      const command = await writeCandidateInput(
        dataRoot,
        commandFor("cancel_0001"),
      );
      const controller = new AbortController();
      await expect(
        handleBuildCandidate({
          command,
          execute: ({ command: parsed, onStage, signal }) =>
            buildCandidateVersion({
              command: parsed,
              createdAtMs,
              layout: dataRoot.layout,
              onStage,
              preparationDiagnostics: [],
              ...(signal ? { signal } : {}),
            }),
          onProgress(message) {
            if (
              message.phase === "render_pages" &&
              message.progress.completed === 0
            ) {
              controller.abort();
            }
          },
          signal: controller.signal,
        }),
      ).rejects.toThrow();
      await expect(
        access(resolve(dataRoot.layout.temporaryDirectory, command.jobId)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        access(
          resolve(
            dataRoot.layout.bookDirectory,
            String(bookId),
            "versions",
            command.versionId,
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        await readdir(
          resolve(dataRoot.layout.bookDirectory, String(bookId), "versions"),
        ).catch(() => []),
      ).toEqual([]);
    } finally {
      await dataRoot.cleanup();
    }
  });

  it("rejects a copied original that does not match its frozen digest", async () => {
    const dataRoot = await createTemporaryDataRoot(
      "candidate-original-integrity",
    );
    try {
      const command = await writeCandidateInput(
        dataRoot,
        commandFor("original_integrity_0001"),
        {
          originalContents: "not the registered original",
          originalSha256: "f".repeat(64),
        },
      );

      await expect(
        buildCandidateVersion({
          command,
          createdAtMs,
          layout: dataRoot.layout,
          preparationDiagnostics: [],
        }),
      ).rejects.toThrow("CANDIDATE_ORIGINAL_CHANGED");
      await expect(
        access(
          resolve(
            dataRoot.layout.bookDirectory,
            String(bookId),
            "versions",
            command.versionId,
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await dataRoot.cleanup();
    }
  });

  it("rejects an invalid referenced image before a candidate becomes ready", async () => {
    const dataRoot = await createTemporaryDataRoot("candidate-image-format");
    try {
      const command = await writeCandidateInput(
        dataRoot,
        commandFor("image_format_0001"),
        {
          resource: {
            contents: Buffer.from("not a raster image"),
            filename: "image.png",
          },
        },
      );

      await expect(
        buildCandidateVersion({
          command,
          createdAtMs,
          layout: dataRoot.layout,
          preparationDiagnostics: [],
        }),
      ).rejects.toMatchObject({ code: "IMAGE_DECODE_FAILED" });
      await expect(
        access(
          resolve(
            dataRoot.layout.bookDirectory,
            String(bookId),
            "versions",
            command.versionId,
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await dataRoot.cleanup();
    }
  });

  it.each([
    "before_fsync",
    "after_fsync_before_rename",
    "after_rename",
  ] as const)(
    "leaves only recoverable output when interrupted at %s",
    async (point) => {
      const dataRoot = await createTemporaryDataRoot(
        `candidate-crash-${point}`,
      );
      try {
        const command = await writeCandidateInput(
          dataRoot,
          commandFor(`crash_${point}`),
        );
        await expect(
          handleBuildCandidate({
            command,
            execute: ({ command: parsed, onStage, signal }) =>
              buildCandidateVersion({
                command: parsed,
                crashPoint(crashPoint: CandidateTreeCrashPoint) {
                  if (crashPoint === point) throw new Error(`CRASH_${point}`);
                },
                createdAtMs,
                layout: dataRoot.layout,
                onStage,
                preparationDiagnostics: [],
                ...(signal ? { signal } : {}),
              }),
          }),
        ).rejects.toThrow(`CRASH_${point}`);

        const finalDirectory = resolve(
          dataRoot.layout.bookDirectory,
          String(bookId),
          "versions",
          command.versionId,
        );
        if (point === "after_rename") {
          await access(finalDirectory);
        } else {
          await expect(access(finalDirectory)).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
        await access(resolve(dataRoot.layout.root, "staging", command.jobId));
        const migrated = await openMigratedTestDatabase(dataRoot);
        try {
          const reconciliation = await reconcileStorage({
            database: migrated.database,
            layout: dataRoot.layout,
            nowMs: createdAtMs + 1,
          });
          expect(reconciliation.removedStagingDirectories).toContain(
            command.jobId,
          );
          if (point === "after_rename") {
            expect(reconciliation.quarantinedDirectories).toEqual([
              `books/${bookId}/quarantine/${command.versionId}.${createdAtMs + 1}`,
            ]);
          } else {
            expect(reconciliation.quarantinedDirectories).toEqual([]);
          }
        } finally {
          migrated.close();
        }
        await expect(access(finalDirectory)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await dataRoot.cleanup();
      }
    },
  );

  it.each([
    "after_version_before_candidate",
    "after_candidate_before_job",
  ] as const)(
    "rolls back ready registration interrupted at %s",
    async (point) => {
      const dataRoot = await createTemporaryDataRoot(`registration-${point}`);
      const migrated = await openMigratedTestDatabase(dataRoot);
      try {
        const { artifact, command, fixture } = await registrationFixture(
          migrated.database,
          dataRoot,
        );
        await expect(
          finalizeCandidate({
            artifact,
            command,
            leaseOwner: publicationTestLeaseOwner,
            nowMs: createdAtMs + 1,
            registration: new CandidateRegistrationAdapter(
              migrated.database,
              dataRoot.layout,
              new BookPresentationRepository(migrated.database),
              (crashPoint: CandidateRegistrationCrashPoint) => {
                if (crashPoint === point) throw new Error(`CRASH_${point}`);
              },
            ),
          }),
        ).rejects.toThrow(`CRASH_${point}`);

        expect(
          new VersionRepository(migrated.database).find(command.versionId),
        ).toBeNull();
        expect(fixture.candidates.require(command.candidateId)).toMatchObject({
          state: "building",
          versionId: null,
        });
        expect(fixture.jobs.get(command.jobId)).toMatchObject({
          state: "running",
        });
        for (const table of [
          "book_version_presentations",
          "search_fts",
          "search_short_fields",
        ]) {
          expect(
            migrated.database
              .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
              .get(),
          ).toEqual({ count: 0 });
        }
      } finally {
        migrated.close();
        await dataRoot.cleanup();
      }
    },
  );

  it("returns an already committed ready registration after its response is lost", async () => {
    const dataRoot = await createTemporaryDataRoot("registration-after-commit");
    const migrated = await openMigratedTestDatabase(dataRoot);
    try {
      const { artifact, command, fixture } = await registrationFixture(
        migrated.database,
        dataRoot,
      );
      await expect(
        finalizeCandidate({
          artifact,
          command,
          leaseOwner: publicationTestLeaseOwner,
          nowMs: createdAtMs + 1,
          registration: new CandidateRegistrationAdapter(
            migrated.database,
            dataRoot.layout,
            new BookPresentationRepository(migrated.database),
            (point) => {
              if (point === "after_commit") throw new Error("RESPONSE_LOST");
            },
          ),
        }),
      ).rejects.toThrow("RESPONSE_LOST");

      await expect(
        finalizeCandidate({
          artifact,
          command,
          leaseOwner: publicationTestLeaseOwner,
          nowMs: createdAtMs + 2,
          registration: new CandidateRegistrationAdapter(
            migrated.database,
            dataRoot.layout,
            new BookPresentationRepository(migrated.database),
          ),
        }),
      ).resolves.toEqual({
        candidateId: command.candidateId,
        semanticDigest: artifact.semanticDigest,
        versionId: command.versionId,
      });
      expect(
        new VersionRepository(migrated.database).require(command.versionId)
          .state,
      ).toBe("ready");
      expect(fixture.candidates.require(command.candidateId).state).toBe(
        "ready",
      );
      expect(fixture.jobs.get(command.jobId)?.state).toBe("succeeded");
      expect(
        migrated.database
          .prepare("SELECT COUNT(*) AS count FROM book_version_presentations")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      migrated.close();
      await dataRoot.cleanup();
    }
  });

  it("rejects a completed tree after a newer candidate becomes current", async () => {
    const dataRoot = await createTemporaryDataRoot(
      "registration-stale-attempt",
    );
    const migrated = await openMigratedTestDatabase(dataRoot);
    try {
      const { artifact, command, fixture } = await registrationFixture(
        migrated.database,
        dataRoot,
      );
      const newer = fixture.candidates.createForDocument({
        bookId: command.bookId,
        sourceUpdatedAt: command.sourceUpdatedAt,
        nowMs: createdAtMs + 1,
        importId: command.importId,
      });

      await expect(
        finalizeCandidate({
          artifact,
          command,
          leaseOwner: publicationTestLeaseOwner,
          nowMs: createdAtMs + 2,
          registration: new CandidateRegistrationAdapter(
            migrated.database,
            dataRoot.layout,
            new BookPresentationRepository(migrated.database),
          ),
        }),
      ).rejects.toThrow("CANDIDATE_FINALIZATION_STALE");
      expect(
        new VersionRepository(migrated.database).find(command.versionId),
      ).toBeNull();
      expect(fixture.candidates.require(command.candidateId).state).toBe(
        "discarded",
      );
      expect(fixture.candidates.findCurrent(command.bookId)?.attemptId).toBe(
        newer.attemptId,
      );
    } finally {
      migrated.close();
      await dataRoot.cleanup();
    }
  });
});
