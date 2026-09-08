import type { APIRoute } from "astro";

import { createPublicationServer } from "@/composition/server/publication";
import { SafeApplicationError } from "@/domain/errors";
import { isOpaqueId } from "@/domain/ids";
import { requireRuntimeAdministrator } from "@/http/authorization/runtime-admin";
import { applyResponsePolicy } from "@/http/cache/policies";
import { readBoundedJson } from "@/http/json-body";
import { requireMutationOrigin } from "@/http/origin";
import { getRuntimeEnvironment } from "@/composition/storage";

export const prerender = false;

function bookId(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

export const POST: APIRoute = async ({ locals, params, request }) => {
  const { database, session } = requireRuntimeAdministrator(locals.session);
  requireMutationOrigin(request, getRuntimeEnvironment().publicOrigin);
  const id = bookId(params.bookId);
  if (!id) {
    throw new SafeApplicationError("NOT_FOUND", "The book was not found.", 404);
  }
  const body = await readBoundedJson(request, 64 * 1024);
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 2
  ) {
    throw new SafeApplicationError(
      "REQUEST_BODY_INVALID",
      "The preview identity and draft timestamp are required.",
      400,
    );
  }
  const command = body as Record<string, unknown>;
  if (
    typeof command.expected_updated_at !== "number" ||
    !Number.isSafeInteger(command.expected_updated_at) ||
    command.expected_updated_at < 0 ||
    command.expected_updated_at > 8_640_000_000_000_000 ||
    typeof command.build_id !== "string" ||
    !isOpaqueId("version", command.build_id)
  )
    throw new SafeApplicationError(
      "REQUEST_BODY_INVALID",
      "The publication command is invalid.",
      400,
    );
  const publishing = createPublicationServer(database);
  const published = await publishing.publishBuild({
    actorUserId: session?.user.id ?? null,
    bookId: id,
    expectedUpdatedAt: command.expected_updated_at,
    buildId: command.build_id,
    nowMs: Date.now(),
  });
  const headers = new Headers();
  applyResponsePolicy(headers, "private-api");
  return Response.json(
    {
      published_at: published.publishedAtMs,
      state: published.state,
      version_id: published.versionId,
    },
    { headers, status: 200 },
  );
};
