import type { APIRoute } from "astro";

import {
  createPublishingArtifactServer,
  createPublishingDraftServer,
} from "@/composition/server/publishing-drafts";
import { getRuntimeStorageLayout } from "@/composition/storage";
import { SafeApplicationError } from "@/domain/errors";
import { isOpaqueId } from "@/domain/ids";
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
  const resourceId = params.resourceId;
  if (!bookId || !resourceId || !isOpaqueId("resource", resourceId)) {
    throw new SafeApplicationError(
      "NOT_FOUND",
      "The image was not found.",
      404,
    );
  }
  const publishing = createPublishingDraftServer(database);
  const book = publishing.findBook(bookId);
  const image = publishing.findDraftImage(bookId, resourceId);
  if (!book?.draftImportId || !image) {
    throw new SafeApplicationError(
      "NOT_FOUND",
      "The image was not found.",
      404,
    );
  }
  const layout = await getRuntimeStorageLayout();
  const resource =
    await createPublishingArtifactServer(layout).readCatalogueResource(image);
  const headers = new Headers({
    "Content-Type": resource.mediaType,
    "X-Content-Type-Options": "nosniff",
  });
  applyResponsePolicy(headers, "draft");
  return new Response(resource.body, { headers });
};
