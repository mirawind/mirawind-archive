import { describe, expect, it } from "vitest";

import {
  authorizePreviewHtmlResources,
  authorizePreviewResource,
  issuePreviewResourceAuthorization,
  previewAuthorizationLifetimeMs,
} from "@/http/authorization/preview-resource";
import { InstallationRepository } from "@/modules/identity/adapters/sqlite/installation";

import { createTemporaryDataRoot } from "../../helpers/data-root.js";
import { openMigratedTestDatabase } from "../../helpers/database.js";

const authSecret = "preview-test-secret-0123456789-abcdef";
const nowMs = 10_000;
const resourceId = "res_0123456789abcdefghij";
const buildId = "ver_0123456789abcdefghij";
const session = {
  authenticatedAtMs: nowMs,
  expiresAtMs: nowMs + previewAuthorizationLifetimeMs * 2,
  sessionId: "session-preview",
  user: {
    email: "admin@example.test",
    id: "admin",
    name: "Administrator",
  },
} as const;

describe("sandboxed preview resource authorization", () => {
  it("binds one-hour authorization to the active admin session, candidate and resource", async () => {
    const dataRoot = await createTemporaryDataRoot("preview-authorization");
    const migrated = await openMigratedTestDatabase(dataRoot);
    try {
      new InstallationRepository(migrated.database).ensure(nowMs);
      migrated.database
        .prepare(
          `INSERT INTO user
             (id, name, email, emailVerified, image, createdAt, updatedAt)
           VALUES (?, ?, ?, 1, NULL, ?, ?)`,
        )
        .run(
          session.user.id,
          session.user.name,
          session.user.email,
          nowMs,
          nowMs,
        );
      new InstallationRepository(migrated.database).registerSoleAdministrator(
        session.user.id,
        nowMs,
      );
      migrated.database
        .prepare(
          `INSERT INTO session
             (id, expiresAt, token, createdAt, updatedAt, userId)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          session.sessionId,
          session.expiresAtMs,
          "private-session-token",
          nowMs,
          nowMs,
          session.user.id,
        );

      const authorization = issuePreviewResourceAuthorization({
        authSecret,
        bookId: 7,
        nowMs,
        resourceId,
        buildId,
        session,
      });
      const base = {
        authorization,
        authSecret,
        bookId: 7,
        database: migrated.database,
        nowMs: nowMs + 1,
        resourceId,
        buildId,
      } as const;
      expect(authorizePreviewResource(base)).toBe(true);
      expect(
        authorizePreviewResource({ ...base, resourceId: `${resourceId}x` }),
      ).toBe(false);
      expect(
        authorizePreviewResource({ ...base, buildId: buildId + "x" }),
      ).toBe(false);
      expect(
        authorizePreviewResource({
          ...base,
          nowMs: nowMs + previewAuthorizationLifetimeMs + 1,
        }),
      ).toBe(false);

      migrated.database
        .prepare("DELETE FROM session WHERE id = ?")
        .run(session.sessionId);
      expect(authorizePreviewResource(base)).toBe(false);

      const localSession = {
        ...session,
        sessionId: "local-development",
      };
      const localAuthorization = issuePreviewResourceAuthorization({
        authSecret,
        bookId: 7,
        nowMs,
        resourceId,
        buildId,
        session: localSession,
      });
      const localBase = { ...base, authorization: localAuthorization };
      expect(authorizePreviewResource(localBase)).toBe(false);
      expect(
        authorizePreviewResource({
          ...localBase,
          allowLocalDevelopmentSession: true,
        }),
      ).toBe(true);
    } finally {
      migrated.close();
      await dataRoot.cleanup();
    }
  });

  it("authorizes only generated resource URLs and reuses a token per resource", () => {
    const url = `/api/manage/books/7/preview/${buildId}/assets/${resourceId}`;
    const html = `<img src="${url}"><a href="${url}">image</a><img src="/other/${resourceId}">`;
    const authorized = authorizePreviewHtmlResources({
      authSecret,
      bookId: 7,
      html,
      nowMs,
      buildId,
      session,
    });
    const tokens = [...authorized.matchAll(/[?&]authorization=([^"&]+)/gu)].map(
      (match) => match[1],
    );
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBe(tokens[1]);
    expect(authorized).toContain(`src="/other/${resourceId}"`);
    expect(authorized).not.toContain("private-session-token");
  });
});
