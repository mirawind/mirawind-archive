import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type Database from "better-sqlite3";

import type { BookVersionPresentationWriter } from "@/modules/catalog/application/catalog-api";
import { readBuildSearchSpool } from "../filesystem/build-search-spool";
import { VersionRepository } from "./versions";
import { DocumentRepository } from "./documents";
import { JobRepository } from "./jobs";
import type { BuildRegistrationPort } from "../../application/commands/finalize-build";
import {
  deriveBookVersionPresentation,
  type BuildBookCommand,
  type BuildArtifact,
} from "../../application/publishing-api";
import {
  validateDocumentManifest,
  validateVersionMarker,
} from "../../core/publication/document-manifest-schema";
import type { StorageLayout } from "@/platform/filesystem/storage-layout";
import { resolveContainedPath } from "@/platform/filesystem/contained-path";
import { withImmediateTransaction } from "@/platform/sqlite/immediate-transaction";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface RegisteredBuild {
  readonly semanticDigest: string;
  readonly versionId: string;
}

export type BuildRegistrationCrashPoint =
  "after_version_before_job" | "after_commit";

export type BuildRegistrationCrashPointInjector = (
  point: BuildRegistrationCrashPoint,
) => void;

export class BuildRegistrationRepository implements BuildRegistrationPort<RegisteredBuild> {
  constructor(
    private readonly database: Database.Database,
    private readonly layout: StorageLayout,
    private readonly presentationWriter: BookVersionPresentationWriter,
    private readonly crashPoint?: BuildRegistrationCrashPointInjector,
  ) {}

  async register(input: {
    readonly artifact: BuildArtifact;
    readonly command: BuildBookCommand;
    readonly leaseOwner: string;
    readonly nowMs: number;
  }): Promise<RegisteredBuild> {
    const buildDirectory = await resolveContainedPath(
      this.layout.root,
      input.artifact.artifactRootRelativePath,
    );
    const [manifestBytes, markerBytes, bookDocument, spool] = await Promise.all(
      [
        readFile(resolve(buildDirectory, "document-manifest.json")),
        readFile(resolve(buildDirectory, "version.json")),
        readFile(resolve(buildDirectory, "book.json"), "utf8"),
        readBuildSearchSpool(
          resolve(
            this.layout.root,
            "staging",
            input.command.jobId,
            "search-rows.ndjson",
          ),
        ),
      ],
    );
    if (
      sha256(manifestBytes) !== input.artifact.manifestSha256 ||
      sha256(markerBytes) !== input.artifact.versionMarkerSha256 ||
      spool.ftsRows.length + spool.shortRows.length !==
        input.artifact.searchRowCount
    ) {
      throw new Error("BUILD_ARTIFACT_INTEGRITY_MISMATCH");
    }
    const manifest = validateDocumentManifest(
      JSON.parse(manifestBytes.toString("utf8")),
    );
    const marker = validateVersionMarker(
      JSON.parse(markerBytes.toString("utf8")),
    );
    const compiler = marker.compiler as Readonly<Record<string, unknown>>;
    if (
      marker.version_id !== input.command.versionId ||
      marker.book_id !== input.command.bookId ||
      marker.book_document_sha256 !== input.command.documentSha256 ||
      marker.source_updated_at !== input.command.sourceUpdatedAt ||
      marker.predecessor_version_id !==
        input.command.capturedCurrentVersionId ||
      compiler.version !== input.command.compilerIdentity ||
      compiler.renderer_version !== input.command.rendererIdentity ||
      manifest.version_id !== input.command.versionId ||
      (manifest.pages as readonly unknown[]).length !== input.artifact.pageCount
    ) {
      throw new Error("BUILD_ARTIFACT_IDENTITY_MISMATCH");
    }
    const presentation = deriveBookVersionPresentation({
      bookDocument: JSON.parse(bookDocument),
      createdAtMs: input.nowMs,
      documentManifest: manifest,
    });
    const blocks = manifest.blocks as Readonly<
      Record<string, Readonly<Record<string, unknown>>>
    >;

    const registered = withImmediateTransaction(this.database, () => {
      new DocumentRepository(this.database).requireTimestamp(
        input.command.bookId,
        input.command.sourceUpdatedAt,
      );
      const job = new JobRepository(this.database).get(input.command.jobId);
      const registeredVersion = new VersionRepository(this.database).find(
        input.command.versionId,
      );
      if (
        job?.state === "succeeded" &&
        job.versionId === input.command.versionId &&
        registeredVersion?.createdByJobId === job.id &&
        registeredVersion.semanticDigest === input.artifact.semanticDigest &&
        registeredVersion.sourceUpdatedAt === input.command.sourceUpdatedAt
      )
        return {
          semanticDigest: registeredVersion.semanticDigest,
          versionId: registeredVersion.id,
        };
      const latest = this.database
        .prepare(
          "SELECT version_id FROM jobs WHERE book_id=? AND kind='build_book' ORDER BY rowid DESC LIMIT 1",
        )
        .get(input.command.bookId) as { version_id: string } | undefined;
      if (
        !job ||
        job.versionId !== input.command.versionId ||
        job.bookId !== input.command.bookId ||
        job.state !== "running" ||
        job.leaseOwner !== input.leaseOwner ||
        job.cancellationRequestedAtMs !== null ||
        job.capturedSourceUpdatedAt !== input.command.sourceUpdatedAt ||
        latest?.version_id !== input.command.versionId
      )
        throw new Error("BUILD_FINALIZATION_STALE");
      const current = this.database
        .prepare(
          "SELECT current_version_id FROM books WHERE id=? AND deletion_requested_at IS NULL",
        )
        .get(input.command.bookId) as
        { current_version_id: string | null } | undefined;
      if (
        !current ||
        current.current_version_id !== input.command.capturedCurrentVersionId
      )
        throw new Error("BUILD_FINALIZATION_STALE");
      this.database
        .prepare(
          "UPDATE book_versions SET state='discarded' WHERE book_id=? AND state='ready'",
        )
        .run(input.command.bookId);
      new VersionRepository(this.database).registerReadyWithSearch({
        blockingDiagnosticCount: input.artifact.blockingDiagnosticCount,
        bookId: input.command.bookId,
        compilerVersion: input.command.compilerIdentity,
        completeAtMs: input.nowMs,
        sourceUpdatedAt: input.command.sourceUpdatedAt,
        createdByJobId: input.command.jobId,
        expectedSearchBlockIds: Object.entries(blocks)
          .filter(([, block]) => String(block.normalized_visible_text).trim())
          .map(([blockId]) => blockId),
        manifestSchemaVersion: Number(manifest.schema_version),
        manifestSha256: input.artifact.manifestSha256,
        predecessorVersionId: input.command.capturedCurrentVersionId,
        presentation,
        presentationWriter: this.presentationWriter,
        previewVersion: input.command.previewIdentity,
        readerVersion: input.command.readerIdentity,
        rendererVersion: input.command.rendererIdentity,
        semanticDigest: input.artifact.semanticDigest,
        importId: input.command.importId,
        spool,
        versionId: input.command.versionId,
        versionMarkerSha256: input.artifact.versionMarkerSha256,
        versionRelativePath: input.artifact.artifactRootRelativePath,
      });
      this.crashPoint?.("after_version_before_job");
      new JobRepository(this.database).completeSuccess({
        jobId: input.command.jobId,
        leaseOwner: input.leaseOwner,
        nowMs: input.nowMs,
      });
      return Object.freeze({
        semanticDigest: input.artifact.semanticDigest,
        versionId: input.command.versionId,
      });
    });
    this.crashPoint?.("after_commit");
    return registered;
  }
}
