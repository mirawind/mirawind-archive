import { describe, expect, it } from "vitest";

import { closeRuntimeAuthForTests } from "@/composition/auth";
import { DraftRepository } from "@/modules/publishing/adapters/sqlite/drafts";
import { ImportRepository } from "@/modules/publishing/adapters/sqlite/imports";
import { InstallationRepository } from "@/modules/identity/adapters/sqlite/installation";
import { JobRepository } from "@/modules/publishing/adapters/sqlite/jobs";
import {
  createSafeJsonError,
  safeErrorInputFromUnknown,
} from "@/http/errors/responses";
import { errorPolicyForRequest } from "@/http/errors/error-policy";
import { m1ImportExpiryMs } from "@/modules/publishing/application/publishing-api";
import { resetRuntimeStorageForTests } from "@/composition/storage";

import { GET as getDraft } from "../../../src/pages/api/manage/books/[bookId]/draft.js";
import { POST as buildPreview } from "../../../src/pages/api/manage/books/[bookId]/build.js";
import { GET as getDraftImage } from "../../../src/pages/api/manage/books/[bookId]/draft/images/[resourceId].js";
import { GET as getDraftImages } from "../../../src/pages/api/manage/books/[bookId]/draft/images/index.js";
import { GET as getPreviewAsset } from "../../../src/pages/api/manage/books/[bookId]/preview/[buildId]/assets/[resourceId].js";
import { GET as getPreviewPage } from "../../../src/pages/api/manage/books/[bookId]/preview/[buildId]/pages/[pageId].js";
import { GET as getImport } from "../../../src/pages/api/manage/imports/[importId]/index.js";
import { GET as getJob } from "../../../src/pages/api/manage/jobs/[jobId]/index.js";
import { createTemporaryDataRoot } from "../../helpers/data-root.js";
import { openMigratedTestDatabase } from "../../helpers/database.js";

const environmentKeys = [
  "MIRAWIND_ALLOWED_HOSTS",
  "MIRAWIND_AUTH_SECRET",
  "MIRAWIND_DATA_DIR",
  "MIRAWIND_PASSKEY_RP_ID",
  "MIRAWIND_PUBLIC_ORIGIN",
] as const;

type RouteHandler = (context: never) => unknown;

async function hiddenResponse(
  handler: RouteHandler,
  path: string,
  params: Readonly<Record<string, string>>,
): Promise<Response> {
  try {
    await handler({
      locals: { session: null },
      params,
      request: new Request(`http://localhost${path}`),
    } as never);
  } catch (cause) {
    const safe = safeErrorInputFromUnknown({
      cause,
      policy: errorPolicyForRequest(path, 404),
      requestId: "req_visibility_test",
    });
    return createSafeJsonError(safe);
  }
  throw new Error("Anonymous private route unexpectedly returned a response");
}

describe("draft resource access", () => {
  it("makes existing and missing candidates, tasks, sources, diagnostics, pages and assets indistinguishable", async () => {
    const previous = Object.fromEntries(
      environmentKeys.map((key) => [key, process.env[key]]),
    );
    const dataRoot = await createTemporaryDataRoot("draft-access");
    const migrated = await openMigratedTestDatabase(dataRoot);
    let importedId: string;
    let jobId: string;
    let bookId: number;
    try {
      new InstallationRepository(migrated.database).ensure(1);
      const book = new DraftRepository(migrated.database).createBook({
        nowMs: 1,
        title: "Private test book",
      });
      bookId = book.id;
      const imported = new ImportRepository(migrated.database).createUploaded({
        bookId,
        expiresAtMs: m1ImportExpiryMs,
        id: "imp_0123456789abcdefghij",
        nowMs: 1,
        originalName: "fixture.zip",
        uploadRelativePath: "tmp/uploads/private/original.zip",
        uploadSha256: "a".repeat(64),
        uploadSizeBytes: 1,
      });
      importedId = imported.id;
      jobId = new JobRepository(migrated.database).create({
        importId: imported.id,
        kind: "analyze_import",
        nowMs: 1,
      }).id;
      migrated.database
        .prepare(
          `INSERT INTO "user"
           (id, name, email, emailVerified, image, createdAt, updatedAt)
           VALUES ('admin', 'Administrator', 'admin@example.test', 1, NULL, 1, 1)`,
        )
        .run();
      new InstallationRepository(migrated.database).registerSoleAdministrator(
        "admin",
        2,
      );
      migrated.close();

      process.env.MIRAWIND_ALLOWED_HOSTS = "localhost";
      process.env.MIRAWIND_AUTH_SECRET = "test-only-secret-0123456789-abcdef";
      process.env.MIRAWIND_DATA_DIR = dataRoot.path;
      process.env.MIRAWIND_PASSKEY_RP_ID = "localhost";
      process.env.MIRAWIND_PUBLIC_ORIGIN = "http://localhost";

      const cases: readonly [
        RouteHandler,
        string,
        Readonly<Record<string, string>>,
        Readonly<Record<string, string>>,
      ][] = [
        [
          getImport as RouteHandler,
          `/api/manage/imports/${importedId}`,
          { importId: importedId },
          { importId: "imp_missing0123456789abc" },
        ],
        [
          getJob as RouteHandler,
          `/api/manage/jobs/${jobId}`,
          { jobId },
          { jobId: "job_missing0123456789abc" },
        ],
        [
          getDraft as RouteHandler,
          `/api/manage/books/${bookId}/draft`,
          { bookId: String(bookId) },
          { bookId: "987654" },
        ],
        [
          getDraftImages as RouteHandler,
          `/api/manage/books/${bookId}/draft/images`,
          { bookId: String(bookId) },
          { bookId: "987654" },
        ],
        [
          getDraftImage as RouteHandler,
          `/api/manage/books/${bookId}/draft/images/res_0123456789abcdefghij`,
          {
            bookId: String(bookId),
            resourceId: "res_0123456789abcdefghij",
          },
          {
            bookId: "987654",
            resourceId: "res_missing0123456789abc",
          },
        ],
        [
          getPreviewPage as RouteHandler,
          `/api/manage/books/${bookId}/preview/candidate_0123456789abcdefghij/pages/1`,
          {
            bookId: String(bookId),
            buildId: "candidate_0123456789abcdefghij",
            pageId: "1",
          },
          {
            bookId: "987654",
            buildId: "candidate_0123456789abcdefghij",
            pageId: "1",
          },
        ],
        [
          getPreviewAsset as RouteHandler,
          `/api/manage/books/${bookId}/preview/candidate_0123456789abcdefghij/assets/res_0123456789abcdefghij`,
          {
            bookId: String(bookId),
            buildId: "candidate_0123456789abcdefghij",
            resourceId: "res_0123456789abcdefghij",
          },
          {
            bookId: "987654",
            buildId: "candidate_0123456789abcdefghij",
            resourceId: "res_missing0123456789abc",
          },
        ],
      ];

      for (const [handler, path, existing, missing] of cases) {
        const existingResponse = await hiddenResponse(handler, path, existing);
        const missingResponse = await hiddenResponse(handler, path, missing);
        expect(existingResponse.status).toBe(404);
        expect(existingResponse.headers.get("cache-control")).toBe("no-store");
        expect(existingResponse.headers.get("x-robots-tag")).toContain(
          "noindex",
        );
        expect(await existingResponse.text()).toBe(
          await missingResponse.text(),
        );
      }

      const deniedBuild = await hiddenResponse(
        buildPreview as RouteHandler,
        `/api/manage/books/${bookId}/build`,
        { bookId: String(bookId) },
      );
      expect(deniedBuild.status).toBe(401);
      expect(deniedBuild.headers.get("cache-control")).toContain("no-store");
      expect(deniedBuild.headers.get("x-robots-tag")).toContain("noindex");

      const session = {
        authenticatedAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
        sessionId: "session-test",
        user: {
          email: "admin@example.test",
          id: "admin",
          name: "Administrator",
        },
      };
      const jobResponse = (await (getJob as RouteHandler)({
        locals: { session },
        params: { jobId },
      } as never)) as Response;
      expect(jobResponse.status).toBe(200);
      expect(jobResponse.headers.get("cache-control")).toBe(
        "private, no-store",
      );
      const jobBody = (await jobResponse.json()) as Record<string, unknown>;
      expect(jobBody).toMatchObject({
        attempt: 1,
        job_id: jobId,
        kind: "analyze_import",
        phase: "queued",
        state: "queued",
      });
      expect(jobBody).not.toHaveProperty("lease_owner");
      expect(jobBody).not.toHaveProperty("error_detail");

      const importResponse = (await (getImport as RouteHandler)({
        locals: { session },
        params: { importId: importedId },
      } as never)) as Response;
      expect(await importResponse.json()).toMatchObject({
        current_job: {
          job_id: jobId,
          kind: "analyze_import",
          progress: {
            completed: 0,
            processed_bytes: null,
            total: null,
            unit: "steps",
          },
        },
        import_id: importedId,
        preview: {
          source_updated_at: null,
          state: "unavailable",
          url: null,
        },
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
