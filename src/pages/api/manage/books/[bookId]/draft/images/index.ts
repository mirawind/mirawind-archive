import type { APIRoute } from "astro";

import { createPublishingDraftServer } from "@/composition/server/publishing-drafts";
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
  if (!book?.draftImportId) {
    throw new SafeApplicationError(
      "NOT_FOUND",
      "The images were not found.",
      404,
    );
  }
  const images = publishing.listDraftImages(bookId);
  const headers = new Headers();
  applyResponsePolicy(headers, "private-api");
  return Response.json(
    {
      images: images.map((image) => ({
        height: image.height,
        media_type: image.media_type,
        path: image.storage_rel_path.slice(`books/${bookId}/`.length),
        resource_id: image.resource_id,
        selected: Boolean(image.selected),
        size_bytes: image.size_bytes,
        url: `/api/manage/books/${bookId}/draft/images/${image.resource_id}`,
        width: image.width,
      })),
    },
    { headers },
  );
};
