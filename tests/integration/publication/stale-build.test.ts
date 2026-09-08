import { describe, expect, it } from "vitest";

import { saveDocument } from "@/modules/publishing/adapters/sqlite/save-document";
import { VersionRepository } from "@/modules/publishing/adapters/sqlite/versions";
import {
  BuildPublicationRepository,
  type BuildPromotionCrashPoint,
} from "@/modules/publishing/adapters/sqlite/build-publication";
import {
  m1PublishPolicy,
  publishBuild,
} from "@/modules/publishing/application/publishing-api";

import { withMigratedTestDatabase } from "../../helpers/database.js";
import {
  publicationTestUpdatedAt,
  publicationTestVersionId,
  publishReadyCandidateForTest,
  setupPublicationFixture,
} from "../../helpers/publication.js";

describe("guarded candidate publication compare-and-swap", () => {
  it("atomically promotes the ready candidate and records one audit event", () =>
    withMigratedTestDatabase(async ({ database }) => {
      const fixture = setupPublicationFixture(database);

      await publishReadyCandidateForTest({
        access: "private",
        bookId: fixture.book.id,
        database,
        nowMs: 12,
      });

      expect(fixture.drafts.requireBook(fixture.book.id)).toMatchObject({
        currentVersionId: publicationTestVersionId,
        access: "private",
      });
      expect(
        new VersionRepository(database).require(publicationTestVersionId),
      ).toMatchObject({
        publishedAtMs: 12,
        state: "published",
      });
      expect(fixture.jobs.get(fixture.candidateJob.id)).toMatchObject({
        finishedAtMs: 11,
        state: "succeeded",
        versionId: publicationTestVersionId,
      });
      expect(
        database
          .prepare(
            "SELECT action, version_id FROM audit_events WHERE job_id = ?",
          )
          .all(fixture.candidateJob.id),
      ).toEqual([
        {
          action: "book.published",
          version_id: publicationTestVersionId,
        },
      ]);
    }));

  it("returns the original result when the same candidate is promoted again", () =>
    withMigratedTestDatabase(async ({ database }) => {
      const fixture = setupPublicationFixture(database);
      const first = await publishReadyCandidateForTest({
        bookId: fixture.book.id,
        database,
        nowMs: 12,
      });
      const repeated = await publishReadyCandidateForTest({
        bookId: fixture.book.id,
        database,
        nowMs: 13,
      });

      expect(repeated).toEqual(first);
      expect(
        database
          .prepare(
            "SELECT count(*) AS count FROM audit_events WHERE action = 'book.published'",
          )
          .get(),
      ).toEqual({ count: 1 });
    }));

  it("queues the next candidate after publication without changing the public version", () =>
    withMigratedTestDatabase(async ({ database }) => {
      const fixture = setupPublicationFixture(database);
      await publishReadyCandidateForTest({
        bookId: fixture.book.id,
        database,
        nowMs: 12,
      });

      const next = fixture.candidates.createForDocument({
        bookId: fixture.book.id,
        sourceUpdatedAt: publicationTestUpdatedAt,
        nowMs: 13,
        importId: fixture.imported.id,
      });

      expect(next).toMatchObject({ state: "building" });
      expect(fixture.candidates.require(fixture.build.id)).toMatchObject({
        blockingDiagnosticCount: 0,
        state: "ready",
        id: publicationTestVersionId,
      });
      expect(fixture.drafts.requireBook(fixture.book.id)).toMatchObject({
        currentVersionId: publicationTestVersionId,
        access: "public",
      });
      expect(
        new VersionRepository(database).require(publicationTestVersionId),
      ).toMatchObject({ state: "published" });
    }));

  it("keeps the public pointer empty when the draft becomes stale", () =>
    withMigratedTestDatabase(async ({ database }) => {
      const fixture = setupPublicationFixture(database);
      saveDocument({
        database,
        bookId: fixture.book.id,
        expectedUpdatedAt: publicationTestUpdatedAt,
        patch: { metadata: { title: "New title" } },
        requestId: "stale_test_save_0001",
        nowMs: 13,
      });

      await expect(
        publishReadyCandidateForTest({
          bookId: fixture.book.id,
          database,
          nowMs: 13,
        }),
      ).rejects.toMatchObject({ code: "PUBLICATION_STALE" });
      expect(fixture.drafts.requireBook(fixture.book.id)).toMatchObject({
        currentVersionId: null,
        access: "private",
      });
      expect(
        new VersionRepository(database).require(publicationTestVersionId).state,
      ).toBe("ready");
      expect(fixture.jobs.get(fixture.candidateJob.id)?.state).toBe(
        "succeeded",
      );
    }));

  it.each(["after_version_before_book", "after_book_before_audit"] as const)(
    "rolls back publication interrupted at %s",
    async (point) => {
      await withMigratedTestDatabase(async ({ database }) => {
        const fixture = setupPublicationFixture(database);
        await expect(
          publishBuild({
            actorUserId: null,
            bookId: fixture.book.id,
            expectedUpdatedAt: publicationTestUpdatedAt,
            buildId: fixture.build.id,
            nowMs: 12,
            policy: m1PublishPolicy,
            publication: new BuildPublicationRepository(
              database,
              (crashPoint: BuildPromotionCrashPoint) => {
                if (crashPoint === point) throw new Error(`CRASH_${point}`);
              },
            ),
          }),
        ).rejects.toThrow(`CRASH_${point}`);
        expect(fixture.drafts.requireBook(fixture.book.id)).toMatchObject({
          currentVersionId: null,
          access: "private",
        });
        expect(
          new VersionRepository(database).require(publicationTestVersionId)
            .state,
        ).toBe("ready");
        expect(
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'book.published'",
            )
            .get(),
        ).toEqual({ count: 0 });
      });
    },
  );

  it("returns the committed publication after the first response is lost", () =>
    withMigratedTestDatabase(async ({ database }) => {
      const fixture = setupPublicationFixture(database);
      await expect(
        publishBuild({
          actorUserId: null,
          bookId: fixture.book.id,
          expectedUpdatedAt: publicationTestUpdatedAt,
          buildId: fixture.build.id,
          nowMs: 12,
          policy: m1PublishPolicy,
          publication: new BuildPublicationRepository(database, (point) => {
            if (point === "after_commit") throw new Error("RESPONSE_LOST");
          }),
        }),
      ).rejects.toThrow("RESPONSE_LOST");

      const repeated = await publishReadyCandidateForTest({
        bookId: fixture.book.id,
        database,
        nowMs: 13,
      });
      expect(repeated).toMatchObject({
        publishedAtMs: 12,
        versionId: publicationTestVersionId,
      });
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'book.published'",
          )
          .get(),
      ).toEqual({ count: 1 });
    }));

  it("rejects a pending save submitted between publication capture and promotion", () =>
    withMigratedTestDatabase(async ({ database }) => {
      const fixture = setupPublicationFixture(database);
      await expect(
        publishBuild({
          actorUserId: null,
          bookId: fixture.book.id,
          expectedUpdatedAt: publicationTestUpdatedAt,
          buildId: fixture.build.id,
          nowMs: 12,
          publication: new BuildPublicationRepository(database),
          policy: {
            evaluate() {
              saveDocument({
                requestId: "publish_race_save_001",
                database,
                bookId: fixture.book.id,
                expectedUpdatedAt: publicationTestUpdatedAt,
                patch: { metadata: { title: "Changed" } },
                nowMs: 12,
              });
              return { allowed: true, code: "TEST_ALLOW" };
            },
          },
        }),
      ).rejects.toMatchObject({ code: "DRAFT_PRECONDITION_FAILED" });
      expect(
        fixture.drafts.requireBook(fixture.book.id).currentVersionId,
      ).toBeNull();
    }));

  it("does not promote an old preview even when a newer candidate has the same source time", () =>
    withMigratedTestDatabase(async ({ database }) => {
      const fixture = setupPublicationFixture(database);
      fixture.candidates.createForDocument({
        bookId: fixture.book.id,
        importId: fixture.imported.id,
        sourceUpdatedAt: publicationTestUpdatedAt,
        nowMs: 12,
      });
      await expect(
        publishBuild({
          actorUserId: null,
          bookId: fixture.book.id,
          expectedUpdatedAt: publicationTestUpdatedAt,
          buildId: fixture.build.id,
          nowMs: 13,
          publication: new BuildPublicationRepository(database),
          policy: m1PublishPolicy,
        }),
      ).rejects.toMatchObject({ code: "PUBLICATION_STALE" });
      expect(
        fixture.drafts.requireBook(fixture.book.id).currentVersionId,
      ).toBeNull();
    }));
});
