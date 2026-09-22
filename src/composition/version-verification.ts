import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import type Database from "better-sqlite3";

import { BookPresentationRepository } from "@/modules/catalog/adapters/sqlite/book-presentations";
import { CurrentVersionCatalogRepository } from "@/modules/catalog/adapters/sqlite/current-version-recovery";
import type { BookVersionRecord } from "@/modules/publishing/application/version-record";
import { VersionRepository } from "@/modules/publishing/adapters/sqlite/versions";
import { withImmediateTransaction } from "@/platform/sqlite/immediate-transaction";
import { validateVersionMarker } from "@/modules/publishing/core/publication/document-manifest-schema";
import type { StorageLayout } from "@/platform/filesystem/storage-layout";
import { resolveContainedPath } from "@/platform/filesystem/contained-path";

export type VersionVerificationCode =
  | "VERSION_DIRECTORY_INVALID"
  | "VERSION_FILE_CLOSURE_MISMATCH"
  | "VERSION_FILE_INTEGRITY_MISMATCH"
  | "VERSION_IDENTITY_MISMATCH"
  | "VERSION_MARKER_INVALID"
  | "VERSION_REQUIRED_FILE_INVALID";

export type VersionVerificationResult =
  | Readonly<{ ok: true }>
  | Readonly<{ code: VersionVerificationCode; ok: false }>;

interface DeclaredFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

interface CheckedMarker {
  readonly directory: string;
  readonly files: readonly DeclaredFile[];
  readonly sharedFiles: readonly DeclaredFile[];
}

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function failureCode(error: unknown): VersionVerificationCode {
  if (error instanceof Error) {
    if (
      error.message.includes("SCHEMA") ||
      error.message.includes("MARKER") ||
      error.name.includes("Schema") ||
      error.name.includes("Semantic")
    ) {
      return "VERSION_MARKER_INVALID";
    }
    if (error.message.includes("IDENTITY")) {
      return "VERSION_IDENTITY_MISMATCH";
    }
    if (error.message.includes("CLOSURE")) {
      return "VERSION_FILE_CLOSURE_MISMATCH";
    }
    if (error.message.includes("INTEGRITY")) {
      return "VERSION_FILE_INTEGRITY_MISMATCH";
    }
    if (error.message.includes("REQUIRED")) {
      return "VERSION_REQUIRED_FILE_INVALID";
    }
  }
  return "VERSION_DIRECTORY_INVALID";
}

async function regularFile(path: string, size: number): Promise<void> {
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size !== size
  ) {
    throw new Error("VERSION_REQUIRED_FILE_INVALID");
  }
}

async function checkMarker(
  layout: StorageLayout,
  version: BookVersionRecord,
): Promise<CheckedMarker> {
  const expectedRelativePath = `books/${version.bookId}/builds/${version.id}`;
  if (version.versionRelativePath !== expectedRelativePath) {
    throw new Error("VERSION_IDENTITY_MISMATCH");
  }
  const directory = await resolveContainedPath(
    layout.root,
    version.versionRelativePath,
  );
  const directoryMetadata = await lstat(directory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw new Error("VERSION_DIRECTORY_INVALID");
  }
  const markerPath = resolve(directory, "version.json");
  const markerMetadata = await lstat(markerPath);
  if (
    markerMetadata.isSymbolicLink() ||
    !markerMetadata.isFile() ||
    markerMetadata.size > 16 * 1024 * 1024
  ) {
    throw new Error("VERSION_MARKER_INVALID");
  }
  const marker = validateVersionMarker(
    JSON.parse(await readFile(markerPath, "utf8")) as unknown,
  );
  if (
    marker.book_id !== version.bookId ||
    marker.version_id !== version.id ||
    marker.source_updated_at !== version.sourceUpdatedAt ||
    marker.predecessor_version_id !== version.predecessorVersionId ||
    marker.manifest_sha256 !== version.manifestSha256 ||
    (marker.compiler as Readonly<Record<string, unknown>>).version !==
      version.compilerVersion ||
    (marker.compiler as Readonly<Record<string, unknown>>).renderer_version !==
      version.rendererVersion
  ) {
    throw new Error("VERSION_IDENTITY_MISMATCH");
  }
  const files = (
    marker.files as readonly Readonly<Record<string, unknown>>[]
  ).map((file) =>
    Object.freeze({
      path: String(file.path),
      sha256: String(file.sha256),
      size: Number(file.size),
    }),
  );
  const sharedFiles = marker.shared_files as unknown as readonly DeclaredFile[];
  return Object.freeze({ directory, files: Object.freeze(files), sharedFiles });
}

export async function verifyVersionQuickly(
  layout: StorageLayout,
  version: BookVersionRecord,
): Promise<VersionVerificationResult> {
  try {
    const checked = await checkMarker(layout, version);
    for (const file of checked.sharedFiles)
      await regularFile(
        await resolveContainedPath(
          layout.root,
          `books/${version.bookId}/${file.path}`,
        ),
        file.size,
      );
    const byPath = new Map(checked.files.map((file) => [file.path, file]));
    const authorities = ["book.json", "document-manifest.json"] as const;
    for (const path of authorities) {
      const declared = byPath.get(path);
      if (!declared) throw new Error("VERSION_REQUIRED_FILE_INVALID");
      const target = resolve(checked.directory, path);
      await regularFile(target, declared.size);
      if ((await digest(target)) !== declared.sha256) {
        throw new Error("VERSION_FILE_INTEGRITY_MISMATCH");
      }
    }
    const firstPage = checked.files.find((file) =>
      /^published\/pages\/[^/]+\.html$/u.test(file.path),
    );
    if (!firstPage) throw new Error("VERSION_REQUIRED_FILE_INVALID");
    await regularFile(
      resolve(checked.directory, firstPage.path),
      firstPage.size,
    );
    return Object.freeze({ ok: true });
  } catch (error) {
    return Object.freeze({ code: failureCode(error), ok: false });
  }
}

export async function verifyVersionFully(
  layout: StorageLayout,
  version: BookVersionRecord,
): Promise<VersionVerificationResult> {
  try {
    const checked = await checkMarker(layout, version);
    for (const file of checked.sharedFiles) {
      const path = await resolveContainedPath(
        layout.root,
        `books/${version.bookId}/${file.path}`,
      );
      await regularFile(path, file.size);
      if ((await digest(path)) !== file.sha256)
        throw new Error("VERSION_FILE_INTEGRITY_MISMATCH");
    }
    const actual = new Map<
      string,
      { readonly sha256: string; readonly size: number }
    >();
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const child = resolve(directory, entry.name);
        if (entry.isSymbolicLink())
          throw new Error("VERSION_DIRECTORY_INVALID");
        if (entry.isDirectory()) await visit(child);
        else if (entry.isFile()) {
          const path = relative(checked.directory, child).split(sep).join("/");
          if (path !== "version.json") {
            const metadata = await lstat(child);
            actual.set(path, {
              sha256: await digest(child),
              size: metadata.size,
            });
          }
        } else {
          throw new Error("VERSION_DIRECTORY_INVALID");
        }
        if (actual.size > 1_000_000) {
          throw new Error("VERSION_FILE_CLOSURE_MISMATCH");
        }
      }
    };
    await visit(checked.directory);
    if (actual.size !== checked.files.length) {
      throw new Error("VERSION_FILE_CLOSURE_MISMATCH");
    }
    for (const file of checked.files) {
      const found = actual.get(file.path);
      if (!found || found.size !== file.size || found.sha256 !== file.sha256) {
        throw new Error("VERSION_FILE_INTEGRITY_MISMATCH");
      }
    }
    return Object.freeze({ ok: true });
  } catch (error) {
    return Object.freeze({ code: failureCode(error), ok: false });
  }
}

export interface CurrentVersionRecovery {
  readonly bookId: number;
  readonly failedVersionId: string;
  readonly replacementVersionId: string | null;
}

export async function verifyAndRecoverCurrentVersions(input: {
  readonly database: Database.Database;
  readonly layout: StorageLayout;
  readonly nowMs: number;
  readonly presentationIntegrityFailures?: readonly string[];
}): Promise<readonly CurrentVersionRecovery[]> {
  const versions = new VersionRepository(input.database);
  const presentations = new BookPresentationRepository(input.database);
  const catalog = new CurrentVersionCatalogRepository(input.database);
  const presentationIntegrityFailures = new Set(
    input.presentationIntegrityFailures ?? [],
  );
  const books = catalog.listCurrentVersions();
  const recovered: CurrentVersionRecovery[] = [];
  for (const book of books) {
    const current = versions.find(book.currentVersionId);
    const currentPresentation = presentations.find(book.currentVersionId);
    const result =
      current &&
      current.state !== "corrupt" &&
      !presentationIntegrityFailures.has(current.id) &&
      currentPresentation &&
      currentPresentation.bookId === book.bookId &&
      currentPresentation.sourceUpdatedAt === current.sourceUpdatedAt
        ? await verifyVersionQuickly(input.layout, current)
        : ({ code: "VERSION_IDENTITY_MISMATCH", ok: false } as const);
    if (result.ok) continue;

    const candidates = versions
      .listForBook(book.bookId)
      .filter(
        (candidate) =>
          candidate.id !== book.currentVersionId &&
          candidate.state === "superseded" &&
          candidate.publishedAtMs !== null &&
          candidate.verifiedAtMs !== null &&
          candidate.reclaimedAtMs === null,
      )
      .sort(
        (left, right) => (right.publishedAtMs ?? 0) - (left.publishedAtMs ?? 0),
      );
    let replacement: BookVersionRecord | null = null;
    for (const candidate of candidates) {
      const candidatePresentation = presentations.find(candidate.id);
      if (
        presentationIntegrityFailures.has(candidate.id) ||
        !candidatePresentation ||
        candidatePresentation.bookId !== candidate.bookId ||
        candidatePresentation.sourceUpdatedAt !== candidate.sourceUpdatedAt
      ) {
        continue;
      }
      const candidateResult = await verifyVersionQuickly(
        input.layout,
        candidate,
      );
      if (candidateResult.ok) {
        replacement = candidate;
        break;
      }
      versions.markCorrupt(candidate.id, input.nowMs);
    }

    withImmediateTransaction(input.database, () => {
      if (current) versions.markCorrupt(current.id, input.nowMs);
      if (replacement) {
        versions.promoteRecoveredVersion({
          bookId: book.bookId,
          nowMs: input.nowMs,
          versionId: replacement.id,
        });
        catalog.replaceCurrentVersion({
          alias: presentations.require(replacement.id).alias,
          bookId: book.bookId,
          currentVersionId: book.currentVersionId,
          nowMs: input.nowMs,
          replacementVersionId: replacement.id,
        });
      } else {
        catalog.markCurrentVersionUnavailable({
          bookId: book.bookId,
          currentVersionId: book.currentVersionId,
          nowMs: input.nowMs,
        });
      }
    });
    recovered.push(
      Object.freeze({
        bookId: book.bookId,
        failedVersionId: book.currentVersionId,
        replacementVersionId: replacement?.id ?? null,
      }),
    );
  }
  return Object.freeze(recovered);
}
