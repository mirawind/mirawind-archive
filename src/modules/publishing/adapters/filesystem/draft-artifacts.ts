import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  SafeApplicationError,
  createSafeDiagnostic,
  type SafeDiagnostic,
} from "@/domain/errors";
import { validateDocumentManifest } from "../../core/publication/document-manifest-schema";
import type { StorageLayout } from "@/platform/filesystem/storage-layout";
import { resolveContainedPath } from "@/platform/filesystem/contained-path";
import {
  fileHandleWebStream,
  openVerifiedContainedFile,
} from "@/platform/filesystem/verified-file";

function hidden(message: string): never {
  throw new SafeApplicationError("NOT_FOUND", message, 404);
}

export class DraftArtifactReader {
  constructor(private readonly layout: StorageLayout) {}
  async readPreviewModel(
    previewRelativePath: string,
  ): Promise<Record<string, unknown>> {
    const previewRoot = await resolveContainedPath(
      this.layout.root,
      previewRelativePath,
    );
    return JSON.parse(
      await readFile(resolve(previewRoot, "preview-model.json"), "utf8"),
    ) as Record<string, unknown>;
  }

  async listCandidateImages(input: {
    readonly bookId: number;
    readonly versionId: string;
    readonly versionRelativePath: string;
  }): Promise<
    readonly {
      readonly height: number;
      readonly mediaType: string;
      readonly path: string;
      readonly resourceId: string;
      readonly sizeBytes: number;
      readonly width: number;
    }[]
  > {
    try {
      const manifestPath = await resolveContainedPath(
        this.layout.root,
        `${input.versionRelativePath}/document-manifest.json`,
      );
      const manifest = validateDocumentManifest(
        JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
      );
      if (
        manifest.book_id !== input.bookId ||
        manifest.version_id !== input.versionId
      ) {
        return hidden("The draft images were not found.");
      }
      const resources = manifest.resources as Readonly<
        Record<
          string,
          {
            readonly height?: number;
            readonly media_type: string;
            readonly size: number;
            readonly source_path: string;
            readonly width?: number;
          }
        >
      >;
      return Object.freeze(
        Object.entries(resources).flatMap(([resourceId, resource]) => {
          if (resource.height === undefined || resource.width === undefined) {
            return [];
          }
          return [
            Object.freeze({
              height: resource.height,
              mediaType: resource.media_type,
              path: resource.source_path,
              resourceId,
              sizeBytes: resource.size,
              width: resource.width,
            }),
          ];
        }),
      );
    } catch {
      return hidden("The draft images were not found.");
    }
  }

  async readDiagnostics(
    relativePath: string,
  ): Promise<readonly SafeDiagnostic[]> {
    const parsed = JSON.parse(
      await readFile(
        await resolveContainedPath(this.layout.root, relativePath),
        "utf8",
      ),
    ) as { diagnostics?: unknown };
    if (!Array.isArray(parsed.diagnostics)) return [];
    return parsed.diagnostics
      .filter((value): value is SafeDiagnostic =>
        Boolean(
          value &&
          typeof value === "object" &&
          typeof (value as Record<string, unknown>).code === "string" &&
          typeof (value as Record<string, unknown>).message === "string",
        ),
      )
      .slice(0, 10_000)
      .map(createSafeDiagnostic);
  }

  async readPreviewPage(input: {
    readonly pageId: number;
    readonly previewRelativePath: string;
  }): Promise<string> {
    try {
      const previewRoot = await resolveContainedPath(
        this.layout.root,
        input.previewRelativePath,
      );
      return await readFile(
        resolve(previewRoot, "pages", `${input.pageId}.html`),
        "utf8",
      );
    } catch {
      return hidden("The preview was not found.");
    }
  }

  async readPreviewResource(input: {
    readonly bookId: number;
    readonly resourceId: string;
    readonly versionId: string;
    readonly versionRelativePath: string;
  }): Promise<{
    readonly body: ReadableStream<Uint8Array>;
    readonly mediaType: string;
  }> {
    try {
      const manifestPath = await resolveContainedPath(
        this.layout.root,
        `${input.versionRelativePath}/document-manifest.json`,
      );
      const manifest = validateDocumentManifest(
        JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
      );
      if (
        manifest.book_id !== input.bookId ||
        manifest.version_id !== input.versionId
      ) {
        return hidden("The asset was not found.");
      }
      const resources = manifest.resources as Readonly<
        Record<
          string,
          {
            readonly media_type: string;
            readonly output_path: string;
            readonly size: number;
          }
        >
      >;
      const resource = resources[input.resourceId];
      if (!resource) return hidden("The asset was not found.");
      const handle = await openVerifiedContainedFile({
        expectedSize: resource.size,
        relativePath: `books/${input.bookId}/${resource.output_path}`,
        root: this.layout.root,
      });
      return Object.freeze({
        body: fileHandleWebStream(handle),
        mediaType: resource.media_type,
      });
    } catch {
      return hidden("The asset was not found.");
    }
  }
}
