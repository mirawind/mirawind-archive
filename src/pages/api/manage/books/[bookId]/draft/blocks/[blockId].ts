import type { APIRoute } from "astro";

import { createPublishingDraftServer } from "@/composition/server/publishing-drafts";
import { SafeApplicationError } from "@/domain/errors";
import { isOpaqueId } from "@/domain/ids";
import { requireRuntimeAdministrator } from "@/http/authorization/runtime-admin";
import { applyResponsePolicy } from "@/http/cache/policies";

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
