import type { APIRoute } from "astro";
import { publishingDraftActions } from "@/composition/server/publishing-drafts";
import { getRuntimeEnvironment } from "@/composition/storage";
import { SafeApplicationError } from "@/domain/errors";
import { requireRuntimeAdministrator } from "@/http/authorization/runtime-admin";
import { requireMutationOrigin } from "@/http/origin";
import { readBoundedJson } from "@/http/json-body";
import { applyResponsePolicy } from "@/http/cache/policies";

export const prerender = false;
export const POST: APIRoute = async ({ locals, params, request }) => {
  const { database } = requireRuntimeAdministrator(locals.session);
  requireMutationOrigin(request, getRuntimeEnvironment().publicOrigin);
  const bookId = Number(params.bookId),
    body = await readBoundedJson(request);
  if (
    !Number.isSafeInteger(bookId) ||
    bookId < 1 ||
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1
  )
    throw new SafeApplicationError(
      "DRAFT_PATCH_INVALID",
      "A draft timestamp is required.",
      400,
    );
  const expected = (body as { expected_updated_at: unknown })
    .expected_updated_at;
  if (
    typeof expected !== "number" ||
    !Number.isSafeInteger(expected) ||
    expected < 0 ||
    expected > 8640000000000000
  )
    throw new SafeApplicationError(
      "DRAFT_TIMESTAMP_INVALID",
      "A valid draft timestamp is required.",
      400,
    );
  const build = publishingDraftActions.requestPreviewBuild({
    bookId,
    database,
    expectedUpdatedAt: expected,
    nowMs: Date.now(),
  });
  const headers = new Headers();
  applyResponsePolicy(headers, "private-api");
  return Response.json(
    { build_id: build.id, job_id: build.jobId },
    { status: 202, headers },
  );
};
