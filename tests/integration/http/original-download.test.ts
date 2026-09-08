import { mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  closeRuntimeAuthForTests,
  getRuntimeDatabase,
} from "@/composition/auth";
import { resetRuntimeStorageForTests } from "@/composition/storage";

import { GET as getOriginal } from "../../../src/pages/books/[bookKey]/originals/[fileId].js";
import { createTemporaryDataRoot } from "../../helpers/data-root.js";
import { openMigratedTestDatabase } from "../../helpers/database.js";
import {
  publishReadyCandidateForTest,
  publicationTestVersionId,
  setupPublicationFixture,
} from "../../helpers/publication.js";

const environmentKeys = [
  "MIRAWIND_ALLOWED_HOSTS",
  "MIRAWIND_AUTH_SECRET",
  "MIRAWIND_DATA_DIR",
  "MIRAWIND_PASSKEY_RP_ID",
  "MIRAWIND_PUBLIC_ORIGIN",
] as const;

type RouteHandler = (context: never) => Promise<Response>;

afterEach(() => {
  closeRuntimeAuthForTests();
  resetRuntimeStorageForTests();
});

describe("registered original HTTP download", () => {
  it("streams a multi-GiB-capable sparse original with resumable ranges and rechecked access", async () => {
    const previous = Object.fromEntries(
      environmentKeys.map((key) => [key, process.env[key]]),
    );
    const dataRoot = await createTemporaryDataRoot("original-download");
    const migrated = await openMigratedTestDatabase(dataRoot);
    const fileId = "file_original_download_test_0001";
    const sizeBytes = 2 * 1024 * 1024 * 1024;
    const tail = Buffer.from("0123456789abcdef");
    let bookId = 0;
    try {
      const fixture = setupPublicationFixture(migrated.database);
      bookId = fixture.book.id;
      const version = migrated.database
        .prepare(
          "SELECT import_id, version_rel_path FROM book_versions WHERE id = ?",
        )
        .get(publicationTestVersionId) as {
        import_id: string;
        version_rel_path: string;
      };
      const originalPath = resolve(
        dataRoot.layout.root,
        "books",
        String(bookId),
        "originals",
        fileId,
      );
      await mkdir(resolve(originalPath, ".."), {
        mode: 0o700,
        recursive: true,
      });
      const sparse = await open(originalPath, "w", 0o400);
      try {
        await sparse.truncate(sizeBytes);
        await sparse.write(
          tail,
          0,
          tail.byteLength,
          sizeBytes - tail.byteLength,
        );
        await sparse.sync();
      } finally {
        await sparse.close();
      }
      migrated.database
        .prepare(
          `INSERT INTO original_files (
             id, book_id, import_id, role, storage_rel_path, original_name,
             media_type, size_bytes, sha256, created_at
           ) VALUES (?, ?, ?, 'mineru_zip', ?, 'unsafe/original.zip',
                     'application/zip', ?, ?, 11)`,
        )
        .run(
          fileId,
          bookId,
          version.import_id,
          `books/${bookId}/originals/${fileId}`,
          sizeBytes,
          "a".repeat(64),
        );
      await publishReadyCandidateForTest({
        bookId: fixture.book.id,
        database: migrated.database,
        nowMs: 12,
      });
      migrated.close();

      process.env.MIRAWIND_ALLOWED_HOSTS = "localhost";
      process.env.MIRAWIND_AUTH_SECRET = "test-only-secret-0123456789-abcdef";
      process.env.MIRAWIND_DATA_DIR = dataRoot.path;
      process.env.MIRAWIND_PASSKEY_RP_ID = "localhost";
      process.env.MIRAWIND_PUBLIC_ORIGIN = "http://localhost";

      const invoke = (headers: HeadersInit = {}) =>
        (getOriginal as RouteHandler)({
          locals: { session: null },
          params: { bookKey: String(bookId), fileId },
          request: new Request(
            `http://localhost/books/${bookId}/originals/${fileId}`,
            { headers },
          ),
        } as never);

      const suffix = await invoke({ Range: "bytes=-16" });
      expect(suffix.status).toBe(206);
      expect(suffix.headers.get("content-range")).toBe(
        `bytes ${sizeBytes - 16}-${sizeBytes - 1}/${sizeBytes}`,
      );
      expect(Buffer.from(await suffix.arrayBuffer())).toEqual(tail);
      expect(suffix.headers.get("content-disposition")).toContain(
        `filename="book-${bookId}.zip"`,
      );
      expect(suffix.headers.get("cache-control")).toBe("private, no-store");
      expect(suffix.headers.get("x-robots-tag")).toContain("noindex");

      const openEnded = await invoke({
        Range: `bytes=${sizeBytes - 8}-`,
      });
      expect(Buffer.from(await openEnded.arrayBuffer())).toEqual(
        tail.subarray(8),
      );

      const unsatisfiable = await invoke({ Range: `bytes=${sizeBytes}-` });
      expect(unsatisfiable.status).toBe(416);
      expect(unsatisfiable.headers.get("content-range")).toBe(
        `bytes */${sizeBytes}`,
      );
      expect((await invoke({ Range: "bytes=0-1,3-4" })).status).toBe(416);

      const notModified = await invoke({
        "If-None-Match": suffix.headers.get("etag") ?? "",
      });
      expect(notModified.status).toBe(304);
      const matchedIfRange = await invoke({
        "If-Range": suffix.headers.get("etag") ?? "",
        Range: "bytes=-4",
      });
      expect(matchedIfRange.status).toBe(206);
      expect(Buffer.from(await matchedIfRange.arrayBuffer())).toEqual(
        tail.subarray(-4),
      );

      const full = await invoke({
        "If-Range": '"different"',
        Range: "bytes=-16",
      });
      expect(full.status).toBe(200);
      expect(full.headers.get("content-length")).toBe(String(sizeBytes));
      await full.body?.cancel();

      getRuntimeDatabase()
        .prepare("UPDATE books SET access = 'private' WHERE id = ?")
        .run(bookId);
      await expect(
        invoke({
          "If-None-Match": suffix.headers.get("etag") ?? "",
          Range: "bytes=-16",
        }),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        status: 404,
      });
    } finally {
      closeRuntimeAuthForTests();
      resetRuntimeStorageForTests();
      migrated.close();
      for (const key of environmentKeys) {
        const value = previous[key];
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
      await dataRoot.cleanup();
    }
  });
});
