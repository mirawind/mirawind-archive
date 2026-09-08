import type { APIRoute } from "astro";

import {
  createPublishingArtifactServer,
  createPublishingDraftServer,
} from "@/composition/server/publishing-drafts";
import { getRuntimeStorageLayout } from "@/composition/storage";
import { SafeApplicationError } from "@/domain/errors";
import { requireRuntimeAdministrator } from "@/http/authorization/runtime-admin";
import { applyResponsePolicy } from "@/http/cache/policies";

export const prerender = false;

function positiveInteger(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

export const GET: APIRoute = async ({ locals, params }) => {
  const { database } = requireRuntimeAdministrator(locals.session, {
    hideExistence: true,
  });
  const bookId = positiveInteger(params.bookId);
  if (!bookId) {
    throw new SafeApplicationError(
      "NOT_FOUND",
      "The images were not found.",
      404,
    );
  }
  const publishing = createPublishingDraftServer(database);
  const book = publishing.findBook(bookId);
  const candidate = publishing.findCurrentBuild(bookId);
  if (!book?.draftImportId || !candidate?.id || candidate.state !== "ready") {
    throw new SafeApplicationError(
      "NOT_FOUND",
      "The images were not found.",
      404,
    );
  }
  const layout = await getRuntimeStorageLayout();
  const view = publishing.readDraftView(bookId);
  if (candidate.sourceUpdatedAt !== view.updated_at)
    throw new SafeApplicationError(
      "NOT_FOUND",
      "The images were not found.",
      404,
    );
  const artifacts = createPublishingArtifactServer(layout);
  const images = await artifacts.listCandidateImages({
    bookId,
    versionId: candidate.id,
    versionRelativePath: `books/${bookId}/builds/${candidate.id}`,
  });
  const headers = new Headers();
  applyResponsePolicy(headers, "private-api");
  return Response.json(
    {
      images: images.map((image) => ({
        height: image.height,
        media_type: image.mediaType,
        path: image.path,
        resource_id: image.resourceId,
        selected: view.metadata.cover_resource_id === image.resourceId,
        size_bytes: image.sizeBytes,
        url: `/api/manage/books/${bookId}/draft/images/${image.resourceId}`,
        width: image.width,
      })),
    },
    { headers },
  );
};
