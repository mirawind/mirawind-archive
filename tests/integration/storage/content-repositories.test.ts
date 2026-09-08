import { describe, expect, it } from "vitest";
import { DraftRepository } from "@/modules/publishing/adapters/sqlite/drafts";
import { ImportRepository } from "@/modules/publishing/adapters/sqlite/imports";
import { JobRepository } from "@/modules/publishing/adapters/sqlite/jobs";
import { withMigratedTestDatabase } from "../../helpers/database";

describe("single-document import repository", () => {
  it("accepts one v2 path and scopes preparation jobs to its book", () =>
    withMigratedTestDatabase(({ database }) => {
      const imports = new ImportRepository(database),
        jobs = new JobRepository(database);
      const book = new DraftRepository(database).createBook({
        title: "Book",
        nowMs: 1,
      });
      const imported = imports.createUploaded({
        bookId: book.id,
        expiresAtMs: 1000,
        nowMs: 1,
        originalName: "book.zip",
        uploadRelativePath: "tmp/uploads/book.zip",
        uploadSha256: "a".repeat(64),
        uploadSizeBytes: 100,
      });
      expect(() =>
        imports.selectDocument({
          importId: imported.id,
          path: "result/content_list_v2.json",
          nowMs: 2,
        }),
      ).toThrow("IMPORT_STATE_CONFLICT");
      imports.startAnalysis(imported.id, 2);
      expect(() =>
        imports.selectDocument({
          importId: imported.id,
          path: "../content_list_v2.json",
          nowMs: 3,
        }),
      ).toThrow();
      imports.selectDocument({
        importId: imported.id,
        path: "result/content_list_v2.json",
        nowMs: 3,
      });
      const job = jobs.create({
        importId: imported.id,
        kind: "prepare_draft",
        nowMs: 4,
      });
      imports.attachPreparedBook({
        bookId: book.id,
        importId: imported.id,
        nowMs: 5,
      });
      expect(imports.require(imported.id)).toMatchObject({
        sourcePath: "result/content_list_v2.json",
        bookId: book.id,
        state: "draft_ready",
      });
      expect(jobs.get(job.id)?.bookId).toBe(book.id);
    }));
});
