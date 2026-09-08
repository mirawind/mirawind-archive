import { createHmac, timingSafeEqual, type BinaryLike } from "node:crypto";

import type Database from "better-sqlite3";

import type { RequestSession } from "@/modules/identity/application/identity-api";
import { localDevelopmentSessionId } from "@/modules/identity/application/identity-api";
import { isOpaqueId } from "@/domain/ids";

const previewAuthorizationVersion = 2;
export const previewAuthorizationLifetimeMs = 60 * 60 * 1000;

interface PreviewAuthorizationClaims {
  readonly bookId: number;
  readonly expiresAtMs: number;
  readonly resourceId: string;
  readonly buildId: string;
  readonly sessionId: string;
  readonly userId: string;
}

function signature(secret: BinaryLike, payload: string): Buffer {
  return createHmac("sha256", secret)
    .update("mirawind-preview-resource-v2\0")
    .update(payload)
    .digest();
}

function claimsPayload(claims: PreviewAuthorizationClaims): string {
  return Buffer.from(
    JSON.stringify([
      previewAuthorizationVersion,
      claims.sessionId,
      claims.userId,
      claims.bookId,
      claims.buildId,
      claims.resourceId,
      claims.expiresAtMs,
    ]),
    "utf8",
  ).toString("base64url");
}

function parseClaims(payload: string): PreviewAuthorizationClaims | null {
  if (!/^[A-Za-z0-9_-]{20,1600}$/u.test(payload)) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    !Array.isArray(value) ||
    value.length !== 7 ||
    value[0] !== previewAuthorizationVersion ||
    typeof value[1] !== "string" ||
    value[1].length < 1 ||
    value[1].length > 255 ||
    typeof value[2] !== "string" ||
    value[2].length < 1 ||
    value[2].length > 255 ||
    !Number.isSafeInteger(value[3]) ||
    Number(value[3]) < 1 ||
    typeof value[4] !== "string" ||
    !isOpaqueId("version", value[4]) ||
    typeof value[5] !== "string" ||
    !isOpaqueId("resource", value[5]) ||
    !Number.isSafeInteger(value[6]) ||
    Number(value[6]) < 1
  ) {
    return null;
  }
  return Object.freeze({
    bookId: Number(value[3]),
    expiresAtMs: Number(value[6]),
    resourceId: value[5],
    buildId: value[4],
    sessionId: value[1],
    userId: value[2],
  });
}

export function issuePreviewResourceAuthorization(input: {
  readonly authSecret: string;
  readonly bookId: number;
  readonly nowMs: number;
  readonly resourceId: string;
  readonly buildId: string;
  readonly session: RequestSession;
}): string {
  if (
    !isOpaqueId("resource", input.resourceId) ||
    !isOpaqueId("version", input.buildId)
  ) {
    throw new Error("PREVIEW_RESOURCE_ID_INVALID");
  }
  const expiresAtMs = Math.min(
    input.nowMs + previewAuthorizationLifetimeMs,
    input.session.expiresAtMs,
  );
  if (expiresAtMs <= input.nowMs) {
    throw new Error("PREVIEW_SESSION_EXPIRED");
  }
  const payload = claimsPayload({
    bookId: input.bookId,
    expiresAtMs,
    resourceId: input.resourceId,
    buildId: input.buildId,
    sessionId: input.session.sessionId,
    userId: input.session.user.id,
  });
  return `${payload}.${signature(input.authSecret, payload).toString(
    "base64url",
  )}`;
}

export function authorizePreviewResource(input: {
  readonly allowLocalDevelopmentSession?: boolean;
  readonly authorization: string | null;
  readonly authSecret: string;
  readonly bookId: number;
  readonly database: Database.Database;
  readonly nowMs: number;
  readonly resourceId: string;
  readonly buildId: string;
}): boolean {
  if (
    !input.authorization ||
    input.authorization.length > 2048 ||
    !isOpaqueId("resource", input.resourceId)
  ) {
    return false;
  }
  const separator = input.authorization.indexOf(".");
  if (separator < 1 || separator !== input.authorization.lastIndexOf(".")) {
    return false;
  }
  const payload = input.authorization.slice(0, separator);
  const suppliedText = input.authorization.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(suppliedText)) return false;
  const expected = signature(input.authSecret, payload);
  const supplied = Buffer.from(suppliedText, "base64url");
  if (
    supplied.byteLength !== expected.byteLength ||
    !timingSafeEqual(supplied, expected)
  ) {
    return false;
  }
  const claims = parseClaims(payload);
  if (
    !claims ||
    claims.bookId !== input.bookId ||
    claims.buildId !== input.buildId ||
    claims.resourceId !== input.resourceId ||
    claims.expiresAtMs <= input.nowMs ||
    claims.expiresAtMs > input.nowMs + previewAuthorizationLifetimeMs
  ) {
    return false;
  }
  if (
    input.allowLocalDevelopmentSession === true &&
    claims.sessionId === localDevelopmentSessionId
  ) {
    const administrator = input.database
      .prepare(
        `SELECT 1 FROM installation
         WHERE id = 1 AND admin_user_id = ?
         LIMIT 1`,
      )
      .get(claims.userId);
    return Boolean(administrator);
  }
  const active = input.database
    .prepare(
      `SELECT 1
       FROM session AS s
       INNER JOIN installation AS i
         ON i.id = 1 AND i.admin_user_id = s.userId
       WHERE s.id = ?
         AND s.userId = ?
         AND s.expiresAt > ?
       LIMIT 1`,
    )
    .get(claims.sessionId, claims.userId, input.nowMs);
  return Boolean(active);
}

export function authorizePreviewHtmlResources(input: {
  readonly authSecret: string;
  readonly bookId: number;
  readonly html: string;
  readonly nowMs: number;
  readonly buildId: string;
  readonly session: RequestSession;
}): string {
  const prefix = `/api/manage/books/${input.bookId}/preview/${input.buildId}/assets/`;
  const pattern = new RegExp(
    `${prefix.replaceAll("/", "\\/")}(res_[A-Za-z0-9_-]{16,80})`,
    "gu",
  );
  const authorizations = new Map<string, string>();
  return input.html.replace(pattern, (url, resourceId: string) => {
    let authorization = authorizations.get(resourceId);
    if (!authorization) {
      authorization = issuePreviewResourceAuthorization({
        authSecret: input.authSecret,
        bookId: input.bookId,
        nowMs: input.nowMs,
        resourceId,
        buildId: input.buildId,
        session: input.session,
      });
      authorizations.set(resourceId, authorization);
    }
    return `${url}?authorization=${encodeURIComponent(authorization)}`;
  });
}
