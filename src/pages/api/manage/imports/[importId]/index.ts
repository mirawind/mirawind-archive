import type { APIRoute } from "astro";

import { createPublishingImportServer } from "@/composition/server/publishing-imports";
import { createPublishingDraftServer } from "@/composition/server/publishing-drafts";
import { createPublishingJobServer } from "@/composition/server/publishing-jobs";
import { SafeApplicationError } from "@/domain/errors";
import { isOpaqueId } from "@/domain/ids";
import { requireRuntimeAdministrator } from "@/http/authorization/runtime-admin";
import { applyResponsePolicy } from "@/http/cache/policies";

export const prerender = false;

export const GET: APIRoute = ({ locals, params }) => {
  const { database } = requireRuntimeAdministrator(locals.session, {
    hideExistence: true,
  });
  const importId = params.importId;
  if (!importId || !isOpaqueId("import", importId)) {
    throw new SafeApplicationError(
      "IMPORT_NOT_FOUND",
      "The import was not found.",
      404,
    );
  }
  const publishing = createPublishingImportServer(database);
  const drafts = createPublishingDraftServer(database);
  const jobs = createPublishingJobServer(database);
  const snapshot = database
    .transaction(() => {
      const imported = publishing.findImport(importId);
      if (!imported) return null;
      const currentJob = publishing.latestJobForImport(importId);
      const book = imported.bookId ? drafts.findBook(imported.bookId) : null;
      const candidate = book ? drafts.findCurrentBuild(book.id) : null;
      const previewReady = candidate?.state === "ready";
      return {
        book_id: imported.bookId,
        source_path: imported.sourcePath,
        created_at: new Date(imported.createdAtMs).toISOString(),
        current_job: currentJob ? jobs.serializeJobStatus(currentJob) : null,
        error_code: imported.safeErrorCode,
        import_id: imported.id,
        source_name: imported.originalName,
        preview: {
          source_updated_at: candidate?.sourceUpdatedAt ?? null,
          state:
            candidate?.state ??
            (book?.draftImportId ? "building" : "unavailable"),
          url:
            previewReady && imported.bookId
              ? `/manage/books/${imported.bookId}`
              : null,
        },
        state: imported.state,
        updated_at: new Date(imported.updatedAtMs).toISOString(),
      };
    })
    .deferred();
  if (!snapshot) {
    throw new SafeApplicationError(
      "IMPORT_NOT_FOUND",
      "The import was not found.",
      404,
    );
  }
  const headers = new Headers();
  applyResponsePolicy(headers, "private-api");
  return Response.json(snapshot, { headers });
};
