import type { APIRoute } from "astro";

import { publishingDraftActions } from "@/composition/server/publishing-drafts";
import {
  getRuntimeEnvironment,
  getRuntimeStorageLayout,
} from "@/composition/storage";
import { SafeApplicationError } from "@/domain/errors";
import { requireRuntimeAdministrator } from "@/http/authorization/runtime-admin";
import { applyResponsePolicy } from "@/http/cache/policies";
import { readMultipartCover } from "@/http/multipart/cover-form";
import { requireMutationOrigin } from "@/http/origin";

export const prerender = false;

function positiveInteger(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

export const POST: APIRoute = async ({ locals, params, request }) => {
  const { database } = requireRuntimeAdministrator(locals.session);
  requireMutationOrigin(request, getRuntimeEnvironment().publicOrigin);
  const bookId = positiveInteger(params.bookId);
  if (!bookId) {
    throw new SafeApplicationError(
      "NOT_FOUND",
      "The draft was not found.",
      404,
    );
  }
  const upload = await readMultipartCover(request);
  const result = await publishingDraftActions.uploadDraftCover({
    bookId,
    bytes: upload.bytes,
    database,
    expectedUpdatedAt: upload.expectedUpdatedAt,
    filename: upload.filename,
    layout: await getRuntimeStorageLayout(),
    nowMs: Date.now(),
  });
  const headers = new Headers();
  applyResponsePolicy(headers, "private-api");
  return Response.json(result, { headers, status: 200 });
};
