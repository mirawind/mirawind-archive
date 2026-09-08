import type { APIRoute } from "astro";

import {
  createPublishingDraftServer,
  publishingDraftActions,
} from "@/composition/server/publishing-drafts";
import { getRuntimeEnvironment } from "@/composition/storage";
import { SafeApplicationError } from "@/domain/errors";
import { isOpaqueId } from "@/domain/ids";
import { requireRuntimeAdministrator } from "@/http/authorization/runtime-admin";
import { applyResponsePolicy } from "@/http/cache/policies";
import { readBoundedJson } from "@/http/json-body";
import { requireMutationOrigin } from "@/http/origin";

export const prerender = false;

function identity(params: Readonly<Record<string, string | undefined>>): {
  readonly blockId: string;
  readonly bookId: number;
} {
  const bookId = Number(params.bookId);
  const blockId = params.blockId ?? "";
  if (
    !Number.isSafeInteger(bookId) ||
    bookId < 1 ||
    !isOpaqueId("block", blockId)
  ) {
    throw new SafeApplicationError(
      "NOT_FOUND",
      "The draft block was not found.",
      404,
    );
  }
  return { blockId, bookId };
}

export const GET: APIRoute = async ({ locals, params }) => {
  const { database } = requireRuntimeAdministrator(locals.session, {
    hideExistence: true,
  });
  const target = identity(params);
  const result = createPublishingDraftServer(database).getDraftBlock(
    target.bookId,
    target.blockId,
  );
  const headers = new Headers();
  applyResponsePolicy(headers, "private-api");
  return Response.json(
    {
      block_id: result.block_id,
      updated_at: result.updated_at,
      kind: result.kind,
      markdown: result.markdown,
    },
    { headers },
  );
};

export const PATCH: APIRoute = async ({ locals, params, request }) => {
  const { database } = requireRuntimeAdministrator(locals.session);
  requireMutationOrigin(request, getRuntimeEnvironment().publicOrigin);
  const target = identity(params);
  const body = await readBoundedJson(request);
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 2
  )
    throw new SafeApplicationError(
      "DRAFT_PATCH_INVALID",
      "A block edit is required.",
      400,
    );
  const value = body as Record<string, unknown>;
  if (
    typeof value.expected_updated_at !== "number" ||
    typeof value.markdown !== "string"
  )
    throw new SafeApplicationError(
      "DRAFT_PATCH_INVALID",
      "A block edit is required.",
      400,
    );
  const result = publishingDraftActions.saveDocument({
    bookId: target.bookId,
    database,
    expectedUpdatedAt: value.expected_updated_at,
    patch: { block: { block_id: target.blockId, markdown: value.markdown } },
    requestId: request.headers.get("Idempotency-Key") ?? "",
    nowMs: Date.now(),
  });
  const headers = new Headers();
  applyResponsePolicy(headers, "private-api");
  return Response.json(
    { ...result, selected_block_id: target.blockId },
    { headers, status: 200 },
  );
};
