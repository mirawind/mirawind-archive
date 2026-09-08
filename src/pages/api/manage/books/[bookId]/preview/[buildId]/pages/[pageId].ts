import type { APIRoute } from "astro";

import {
  createPublishingArtifactServer,
  createPublishingDraftServer,
} from "@/composition/server/publishing-drafts";
import { SafeApplicationError } from "@/domain/errors";
import { isOpaqueId } from "@/domain/ids";
import { authorizePreviewHtmlResources } from "@/http/authorization/preview-resource";
import { requireRuntimeAdministrator } from "@/http/authorization/runtime-admin";
import { applyResponsePolicy } from "@/http/cache/policies";
import {
  getRuntimeEnvironment,
  getRuntimeStorageLayout,
} from "@/composition/storage";

export const prerender = false;

function positiveInteger(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

export const GET: APIRoute = async ({ locals, params }) => {
  const { database, session } = requireRuntimeAdministrator(locals.session, {
    hideExistence: true,
  });
  const bookId = positiveInteger(params.bookId);
  const buildId = params.buildId ?? "";
  const pageId = positiveInteger(params.pageId);
  if (!bookId || !isOpaqueId("version", buildId) || !pageId) {
    throw new SafeApplicationError(
      "NOT_FOUND",
      "The preview was not found.",
      404,
    );
  }
  const publishing = createPublishingDraftServer(database);
  const book = publishing.findBook(bookId);
  const candidate = publishing.findPreviewBuild(buildId, bookId);
  if (
    !session ||
    !book?.draftImportId ||
    candidate?.id !== buildId ||
    candidate.state !== "ready" ||
    !candidate.id
  ) {
    throw new SafeApplicationError(
      "NOT_FOUND",
      "The preview was not found.",
      404,
    );
  }
  const layout = await getRuntimeStorageLayout();
  const html = authorizePreviewHtmlResources({
    authSecret: getRuntimeEnvironment().authSecret,
    bookId,
    html: await createPublishingArtifactServer(layout).readPreviewPage({
      pageId,
      previewRelativePath: `books/${bookId}/builds/${candidate.id}/preview`,
    }),
    nowMs: Date.now(),
    buildId,
    session,
  });
  const publicOrigin = getRuntimeEnvironment().publicOrigin;
  const headers = new Headers({
    "Content-Security-Policy": [
      "default-src 'none'",
      "base-uri 'none'",
      `font-src ${publicOrigin} data:`,
      "form-action 'none'",
      `frame-ancestors ${publicOrigin}`,
      `img-src ${publicOrigin} data:`,
      "object-src 'none'",
      `script-src ${publicOrigin}`,
      `style-src ${publicOrigin} 'unsafe-inline'`,
    ].join("; "),
    "Content-Type": "text/html; charset=utf-8",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  applyResponsePolicy(headers, "draft");
  return new Response(html, { headers });
};
