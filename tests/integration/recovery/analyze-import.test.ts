import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ImportRepository } from "@/modules/publishing/adapters/sqlite/imports";
import {
  analyzeImport,
  persistAnalyzeImportArtifact,
  readAnalyzeImportArtifact,
} from "@/modules/publishing/adapters/worker/analyze-import";
import { buildZip } from "../../../scripts/fixtures/zip-builder";
import { withMigratedTestDatabase } from "../../helpers/database.js";
import { mineruTitle, mineruParagraph } from "../../helpers/mineru-v2";

const sha256 = "a".repeat(64);

async function runAnalysis(
  dataRoot: { readonly path: string },
  entries: readonly { readonly data: string; readonly name: string }[],
  importId: string,
) {
  await mkdir(dataRoot.path, { recursive: true });
  const archivePath = resolve(dataRoot.path, "input.zip");
  await writeFile(archivePath, buildZip({ entries }));
  const sealedExtractionDirectory = resolve(
    dataRoot.path,
    "tmp/uploads",
    importId,
    "sealed-extraction",
  );
  const result = await analyzeImport({
    archivePath,
    importId,
    sealedExtractionDirectory,
    stagingDirectory: resolve(dataRoot.path, "staging/job_abcdefghijklmnop"),
  });
  return { result, sealedExtractionDirectory };
}

describe("analyze_import handler", () => {
  it("extracts a high-confidence bundle and durably selects it for preparation", () =>
    withMigratedTestDatabase(async ({ database }, dataRoot) => {
      const { result, sealedExtractionDirectory } = await runAnalysis(
        dataRoot,
        [
          {
            data: JSON.stringify([
              [mineruTitle("Book"), mineruParagraph("Body.")],
            ]),
            name: "wrapper/content_list_v2.json",
          },
          { data: "{}", name: "wrapper/layout.json" },
          { data: "image", name: "wrapper/images/a.png" },
        ],
        "imp_abcdefghijklmnop",
      );
      const artifact = await readAnalyzeImportArtifact(result.artifactPath);
      const artifactText = await readFile(result.artifactPath, "utf8");

      expect(artifact).toMatchObject({
        decision: "automatic",
        reason: "mineru-v2",
        document: {
          path: "wrapper/content_list_v2.json",
          size: expect.any(Number),
        },
      });
      expect(artifact.document?.path).toBe("wrapper/content_list_v2.json");
      expect(artifactText).not.toContain(dataRoot.path);
      await expect(
        access(
          resolve(
            sealedExtractionDirectory,
            "tree/wrapper/content_list_v2.json",
          ),
        ),
      ).resolves.toBeUndefined();

      const imports = new ImportRepository(database);
      const imported = imports.createUploaded({
        expiresAtMs: 10_000,
        id: "imp_abcdefghijklmnop",
        nowMs: 1,
        originalName: "fixture.zip",
        uploadRelativePath: "tmp/uploads/imp_abcdefghijklmnop/original.zip",
        uploadSha256: sha256,
        uploadSizeBytes: 10,
      });
      imports.startAnalysis(imported.id, 2);
      expect(
        persistAnalyzeImportArtifact({
          artifact,
          importId: imported.id,
          nowMs: 3,
          repository: imports,
        }),
      ).toMatchObject({
        sourcePath: artifact.document?.path,
        state: "preparing",
      });
      expect(imports.require(imported.id).sourcePath).toBeTruthy();
    }));

  it("rejects missing MinerU v2 content and cleans the extraction", () =>
    withMigratedTestDatabase(async ({ database }, dataRoot) => {
      const imports = new ImportRepository(database);
      const genericRun = await runAnalysis(
        dataRoot,
        [{ data: "# Notes", name: "notes.md" }],
        "imp_abcdefghijklmnop",
      );
      const generic = genericRun.result;
      const first = imports.createUploaded({
        expiresAtMs: 10_000,
        id: "imp_abcdefghijklmnop",
        nowMs: 1,
        originalName: "fixture.zip",
        uploadRelativePath: "tmp/uploads/imp_abcdefghijklmnop/original.zip",
        uploadSha256: sha256,
        uploadSizeBytes: 10,
      });
      imports.startAnalysis(first.id, 2);
      expect(
        persistAnalyzeImportArtifact({
          artifact: generic.artifact,
          importId: first.id,
          nowMs: 3,
          repository: imports,
        }),
      ).toMatchObject({
        sourcePath: null,
        state: "rejected",
        safeErrorCode: "IMPORT_MINERU_JSON_MISSING",
      });
      await expect(
        access(resolve(genericRun.sealedExtractionDirectory, "tree/notes.md")),
      ).rejects.toThrow();

      const secondRoot = {
        path: resolve(dataRoot.path, "second"),
      };
      const rejectedRun = await runAnalysis(
        secondRoot,
        [{ data: "not markdown", name: "readme.txt" }],
        "imp_qrstuvwxyzabcdef",
      );
      const rejected = rejectedRun.result;
      const second = imports.createUploaded({
        expiresAtMs: 10_000,
        id: "imp_qrstuvwxyzabcdef",
        nowMs: 4,
        originalName: "fixture.zip",
        uploadRelativePath: "tmp/uploads/imp_qrstuvwxyzabcdef/original.zip",
        uploadSha256: sha256,
        uploadSizeBytes: 10,
      });
      imports.startAnalysis(second.id, 5);
      expect(
        persistAnalyzeImportArtifact({
          artifact: rejected.artifact,
          importId: second.id,
          nowMs: 6,
          repository: imports,
        }),
      ).toMatchObject({
        safeErrorCode: "IMPORT_MINERU_JSON_MISSING",
        state: "rejected",
      });
      await expect(
        access(rejectedRun.sealedExtractionDirectory),
      ).rejects.toThrow();
      await expect(
        access(
          resolve(secondRoot.path, "staging/job_abcdefghijklmnop/extracted"),
        ),
      ).rejects.toThrow();
    }));
});
