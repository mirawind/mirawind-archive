import type { APIRoute } from "astro";
import {
  createPublishingArtifactServer,
  createPublishingDraftServer,
  publishingDraftActions,
} from "@/composition/server/publishing-drafts";
import { SafeApplicationError, type SafeDiagnostic } from "@/domain/errors";
import { requireRuntimeAdministrator } from "@/http/authorization/runtime-admin";
import { applyResponsePolicy } from "@/http/cache/policies";
import { requireMutationOrigin } from "@/http/origin";
import { readBoundedJson } from "@/http/json-body";
import {
  getRuntimeEnvironment,
  getRuntimeStorageLayout,
} from "@/composition/storage";

export const prerender = false;
function identity(value: string | undefined): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1)
    throw new SafeApplicationError(
      "NOT_FOUND",
      "The draft was not found.",
      404,
    );
  return id;
}
export const GET: APIRoute = async ({ locals, params }) => {
  const { database } = requireRuntimeAdministrator(locals.session, {
    hideExistence: true,
  });
  const bookId = identity(params.bookId);
  const publishing = createPublishingDraftServer(database);
  const book = publishing.findBook(bookId);
  if (!book?.draftImportId)
    throw new SafeApplicationError(
      "NOT_FOUND",
      "The draft was not found.",
      404,
    );
  const artifacts = createPublishingArtifactServer(
    await getRuntimeStorageLayout(),
  );
  const view = publishing.readDraftView(bookId);
  const record = publishing.findCurrentBuild(bookId);
  const build = record?.sourceUpdatedAt === view.updated_at ? record : null;
  let preview: Record<string, unknown> | null = null;
  let diagnostics: readonly SafeDiagnostic[] = [];
  if (build?.state === "ready" && build.id) {
    const path = "books/" + bookId + "/builds/" + build.id + "/preview";
    preview = await artifacts.readPreviewModel(path);
    if (
      preview.source_updated_at !== view.updated_at ||
      preview.build_id !== build.id
    )
      throw new SafeApplicationError(
        "PREVIEW_IDENTITY_INVALID",
        "The preview is unavailable.",
        503,
      );
    diagnostics = await artifacts.readDiagnostics(path + "/diagnostics.json");
  }
  const headers = new Headers();
  applyResponsePolicy(headers, "draft");
  return Response.json(
    {
      access: book.access,
      book_id: book.id,
      build: build
        ? {
            id: build.id,
            job_id: build.jobId,
            state: build.state,
            source_updated_at: build.sourceUpdatedAt,
            safe_error_code: build.safeErrorCode,
          }
        : null,
      build_published: Boolean(
        build?.state === "ready" && build.id === book.currentVersionId,
      ),
      alias: view.alias,
      boundaries: view.publishing.boundaries,
      updated_at: view.updated_at,
      diagnostics,
      metadata: view.metadata,
      numbering: view.publishing.numbering,
      published: book.currentVersionId !== null,
      preview: preview ? { ...preview, is_stale: false } : null,
      structure: view.structure,
      title: view.metadata.title,
    },
    { headers },
  );
};
export const PATCH: APIRoute = async ({ locals, params, request }) => {
  const { database } = requireRuntimeAdministrator(locals.session);
  requireMutationOrigin(request, getRuntimeEnvironment().publicOrigin);
  const bookId = identity(params.bookId);
  const body = await readBoundedJson(request);
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new SafeApplicationError(
      "DRAFT_PATCH_INVALID",
      "A draft edit is required.",
      400,
    );
  const { expected_updated_at, ...patch } = body as Record<string, unknown>;
  if (typeof expected_updated_at !== "number")
    throw new SafeApplicationError(
      "DRAFT_TIMESTAMP_INVALID",
      "A draft timestamp is required.",
      400,
    );
  const result = publishingDraftActions.saveDocument({
    bookId,
    database,
    requestId: request.headers.get("Idempotency-Key") ?? "",
    expectedUpdatedAt: expected_updated_at,
    patch,
    nowMs: Date.now(),
  });
  const headers = new Headers();
  applyResponsePolicy(headers, "private-api");
  return Response.json(result, { headers, status: 200 });
};
