import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createOpaqueId } from "@/domain/ids";
import { extractZipFile } from "../filesystem/extract-archive";
import { claimSealedExtraction } from "../filesystem/sealed-extraction";
import { readJsonDocument } from "../filesystem/read-json-document";
import { importMineruContent } from "../../core/preparation/mineru-content";
import {
  serializeBookDocument,
  validateBookDocument,
} from "../../core/content/book-document";
import { atomicWriteFile } from "@/platform/filesystem/atomic-file";
import { resolveContainedPath } from "@/platform/filesystem/contained-path";
import {
  organizeMineruBook,
  type PdfEvidenceReader,
} from "./organize-mineru-book";
import { prepareBookResources } from "./prepare-book-resources";
import {
  draftPreparationVersion,
  preparationArtifactFilename,
  type PreparedDraftArtifact,
} from "./prepared-draft-artifact";

export interface PrepareDraftResult {
  readonly artifact: PreparedDraftArtifact;
  readonly artifactPath: string;
  readonly extractionSource: "archive" | "sealed";
  readonly extractedRoot: string;
  readonly preparedRoot: string;
}
export async function prepareDraft(input: {
  readonly archivePath: string;
  readonly bookId: number;
  readonly importId?: string;
  readonly sourcePath: string;
  readonly sealedExtractionDirectory?: string;
  readonly signal?: AbortSignal;
  readonly stagingDirectory: string;
  readonly typographyProfile?: "verbatim-v1" | "zh-smart-v2";
  readonly pdfEvidenceReader?: PdfEvidenceReader;
  readonly onPhase?: (
    phase: "identify_document" | "organize_structure" | "extract_archive",
    completed: number,
    total: number,
  ) => void;
}): Promise<PrepareDraftResult> {
  const staging = resolve(input.stagingDirectory);
  const extractedRoot = resolve(staging, "extracted");
  const preparedRoot = resolve(staging, "prepared");
  try {
    await mkdir(staging, { recursive: true, mode: 0o700 });
    input.onPhase?.("extract_archive", 0, 3);
    const sealed =
      input.importId && input.sealedExtractionDirectory
        ? await claimSealedExtraction({
            expectedImportId: input.importId,
            sealedDirectory: input.sealedExtractionDirectory,
            stagingDirectory: staging,
          })
        : null;
    if (!sealed)
      await extractZipFile({
        archivePath: input.archivePath,
        destination: extractedRoot,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    input.signal?.throwIfAborted();
    input.onPhase?.("identify_document", 1, 3);
    const sourcePath = await resolveContainedPath(
      extractedRoot,
      input.sourcePath,
    );
    if (
      !/(?:^|_)content_list_v2\.json$/iu.test(
        sourcePath.split("/").at(-1) ?? "",
      )
    )
      throw new Error("IMPORT_MINERU_JSON_MISSING");
    const parsed = await readJsonDocument(sourcePath, input.signal);
    const imported = importMineruContent(parsed, {
      bookId: input.bookId,
      nowMs: Date.now(),
      title: "Untitled",
    });
    input.onPhase?.("organize_structure", 2, 3);
    const organized = await organizeMineruBook({
      imported,
      sourcePath,
      stagingDirectory: staging,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.typographyProfile
        ? { typographyProfile: input.typographyProfile }
        : {}),
      ...(input.pdfEvidenceReader
        ? { pdfEvidenceReader: input.pdfEvidenceReader }
        : {}),
    });
    const resources = await prepareBookResources(
      organized.book,
      dirname(sourcePath),
      preparedRoot,
      input.signal,
    );
    const document = serializeBookDocument(
      validateBookDocument(organized.book),
    );
    await atomicWriteFile(resolve(preparedRoot, "import/book.json"), document, {
      mode: 0o600,
    });
    await atomicWriteFile(
      resolve(preparedRoot, "import/analysis.json"),
      JSON.stringify(organized.analysis),
      { mode: 0o600 },
    );
    const originalId = createOpaqueId("file");
    const originalPath = resolve(preparedRoot, "originals", originalId);
    await mkdir(dirname(originalPath), { recursive: true, mode: 0o700 });
    await copyFile(input.archivePath, originalPath);
    await chmod(originalPath, 0o400);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(originalPath)) {
      input.signal?.throwIfAborted();
      size += chunk.byteLength;
      if (size > 2 * 1024 * 1024 * 1024)
        throw new Error("ORIGINAL_FILE_LIMIT_EXCEEDED");
      hash.update(chunk);
    }
    const artifact: PreparedDraftArtifact = {
      version: draftPreparationVersion,
      sourcePath: input.sourcePath,
      bookId: input.bookId,
      sourceUpdatedAt: organized.book.updated_at,
      title: organized.book.metadata.title,
      documentSha256: createHash("sha256").update(document).digest("hex"),
      resources,
      original: { id: originalId, size, sha256: hash.digest("hex") },
      diagnostics: organized.analysis.diagnostics,
    };
    const artifactPath = resolve(staging, preparationArtifactFilename);
    await atomicWriteFile(artifactPath, JSON.stringify(artifact) + "\n", {
      mode: 0o600,
    });
    input.onPhase?.("organize_structure", 3, 3);
    return {
      artifact,
      artifactPath,
      extractedRoot,
      preparedRoot,
      extractionSource: sealed ? "sealed" : "archive",
    };
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    throw error;
  }
}
