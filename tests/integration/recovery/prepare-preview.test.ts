import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { analyzeImport } from "@/modules/publishing/adapters/worker/analyze-import";
import { prepareDraft } from "@/modules/publishing/adapters/worker/prepare-draft";
import { finalizePreparedDraft } from "@/modules/publishing/adapters/worker/finalize-prepared-draft";
import { DocumentRepository } from "@/modules/publishing/adapters/sqlite/documents";
import { readPdfContentsEvidence } from "@/modules/publishing/adapters/filesystem/read-pdf-contents-evidence";
import { inlineText } from "@/modules/publishing/core/content/content-tree";
import { createTemporaryDataRoot } from "../../helpers/data-root";
import { withMigratedTestDatabase } from "../../helpers/database";
import {
  mineruZip,
  mineruTitle,
  mineruParagraph,
  mineruText,
} from "../../helpers/mineru-v2";
import { prepareIrBook } from "../../helpers/prepare-ir-book";

describe("MinerU v2 draft handoff", () => {
  it.each(["sealed", "invalid", "canceled"] as const)(
    "safely handles a %s extraction",
    async (mode) => {
      const root = await createTemporaryDataRoot("ir-extraction");
      try {
        const archivePath = resolve(root.path, "book.zip"),
          importId = "imp_sealed_extract_0001";
        const sealedExtractionDirectory = resolve(
          root.layout.uploadDirectory,
          importId,
          "sealed-extraction",
        );
        await writeFile(
          archivePath,
          mineruZip([[mineruTitle("Book"), mineruParagraph("Body")]]),
        );
        await analyzeImport({
          archivePath,
          importId,
          sealedExtractionDirectory,
          stagingDirectory: resolve(root.path, "staging/analysis"),
        });
        if (mode === "invalid")
          await writeFile(
            resolve(sealedExtractionDirectory, "marker.json"),
            "{}",
          );
        const input = {
          archivePath,
          importId,
          bookId: 1,
          sealedExtractionDirectory,
          sourcePath: "result/content_list_v2.json",
          stagingDirectory: resolve(root.path, "staging/preparation"),
        };
        if (mode === "canceled") {
          await expect(
            prepareDraft({ ...input, signal: AbortSignal.abort() }),
          ).rejects.toThrow();
          await expect(access(input.stagingDirectory)).rejects.toMatchObject({
            code: "ENOENT",
          });
          await expect(access(sealedExtractionDirectory)).rejects.toMatchObject(
            { code: "ENOENT" },
          );
        }
        const prepared = await prepareDraft(input);
        expect(prepared.extractionSource).toBe(
          mode === "sealed" ? "sealed" : "archive",
        );
        await expect(access(sealedExtractionDirectory)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(
          await readFile(
            resolve(prepared.extractedRoot, input.sourcePath),
            "utf8",
          ),
        ).toContain("Body");
      } finally {
        await root.cleanup();
      }
    },
  );
  it("accepts validated IR, referenced resources and the original once, with a timestamp-bound candidate", () =>
    withMigratedTestDatabase(async ({ database }, { layout }) => {
      const image = await sharp({
        create: { width: 2, height: 2, channels: 3, background: "white" },
      })
        .png()
        .toBuffer();
      const fixture = await prepareIrBook(
        database,
        layout,
        mineruZip(
          [
            [
              mineruTitle("Prepared Book"),
              mineruParagraph("中文与English排版"),
              {
                type: "image",
                content: {
                  image_source: { path: "images/a.png" },
                  image_caption: [mineruText("Figure")],
                  image_footnote: [],
                },
              },
            ],
          ],
          [
            { name: "result/images/a.png", data: image },
            { name: "result/images/unused.png", data: "unused" },
          ],
        ),
      );
      const book = new DocumentRepository(database).read(fixture.book.id);
      const paragraph = book.blocks.find((block) => block.type === "paragraph");
      expect(paragraph && inlineText(paragraph.content)).toBe(
        "中文与 English 排版",
      );
      expect(book.resources).toHaveLength(1);
      expect(fixture.finalized.build).toMatchObject({
        sourceUpdatedAt: book.updated_at,
        state: "building",
      });
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM original_files").get(),
      ).toEqual({ count: 1 });
      const repeated = await finalizePreparedDraft({
        artifact: fixture.prepared.artifact,
        preparedRoot: fixture.prepared.preparedRoot,
        database,
        importId: fixture.imported.id,
        layout,
        nowMs: 5,
      });
      expect(repeated).toEqual(fixture.finalized);
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM jobs WHERE kind='build_book'")
          .get(),
      ).toEqual({ count: 1 });
      expect(new DocumentRepository(database).read(fixture.book.id)).toEqual(
        book,
      );
    }));
  it("uses only the original PDF for insufficient contents evidence", async () => {
    const root = await createTemporaryDataRoot("ir-pdf-evidence");
    try {
      const archivePath = resolve(root.path, "book.zip");
      await writeFile(
        archivePath,
        mineruZip(
          [[mineruTitle("Book"), mineruParagraph("Body")]],
          [
            { name: "result/book_origin.pdf", data: "%PDF-origin" },
            { name: "result/book_layout.pdf", data: "%PDF-layout" },
          ],
        ),
      );
      const reader = vi.fn(
        async (input: Parameters<typeof readPdfContentsEvidence>[0]) => {
          expect(input.allowOcr).toBe(true);
          return {
            diagnostics: [],
            inspectedPageIndices: [1],
            records: [],
            source: "native-pdf" as const,
          };
        },
      );
      const prepared = await prepareDraft({
        archivePath,
        bookId: 1,
        sourcePath: "result/content_list_v2.json",
        stagingDirectory: resolve(root.path, "staging/preparation"),
        pdfEvidenceReader: reader,
      });
      expect(reader).toHaveBeenCalledOnce();
      expect(reader.mock.calls[0]?.[0].pdfPath).toBe(
        resolve(prepared.extractedRoot, "result/book_origin.pdf"),
      );
    } finally {
      await root.cleanup();
    }
  });
  it("removes failed preparation output when a referenced resource is missing", async () => {
    const root = await createTemporaryDataRoot("ir-resource-missing");
    try {
      const archivePath = resolve(root.path, "book.zip"),
        stagingDirectory = resolve(root.path, "staging/preparation");
      await mkdir(resolve(root.path, "staging"), { recursive: true });
      await writeFile(
        archivePath,
        mineruZip([
          [
            mineruTitle("Book"),
            {
              type: "image",
              content: {
                image_source: { path: "missing.png" },
                image_caption: [],
                image_footnote: [],
              },
            },
          ],
        ]),
      );
      await expect(
        prepareDraft({
          archivePath,
          stagingDirectory,
          bookId: 1,
          sourcePath: "result/content_list_v2.json",
        }),
      ).rejects.toThrow();
      await expect(access(stagingDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await root.cleanup();
    }
  });
});
