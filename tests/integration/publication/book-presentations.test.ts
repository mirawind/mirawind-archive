import { describe, expect, it } from "vitest";

import { BookPresentationRepository } from "@/modules/catalog/adapters/sqlite/book-presentations";

import { withMigratedTestDatabase } from "../../helpers/database.js";
import {
  publishReadyCandidateForTest,
  publicationTestVersionId,
  setupPublicationFixture,
} from "../../helpers/publication.js";

describe("current-version presentation publication", () => {
  it("keeps public metadata frozen while draft caches change", () =>
    withMigratedTestDatabase(async ({ database }) => {
      const fixture = setupPublicationFixture(database);
      const presentations = new BookPresentationRepository(database);

      expect(presentations.require(publicationTestVersionId)).toMatchObject({
        title: "Book",
        versionId: publicationTestVersionId,
      });
      database
        .prepare(
          "UPDATE books SET title_cache = 'Unpublished title' WHERE id = ?",
        )
        .run(fixture.book.id);

      await publishReadyCandidateForTest({
        bookId: fixture.book.id,
        database,
        nowMs: 12,
      });

      expect(
        presentations.requireCurrentForBook(fixture.book.id),
      ).toMatchObject({
        title: "Book",
        versionId: publicationTestVersionId,
      });
      expect(fixture.drafts.requireBook(fixture.book.id).title).toBe(
        "Unpublished title",
      );
      expect(fixture.jobs.get(fixture.candidateJob.id)).toMatchObject({
        kind: "build_book",
        state: "succeeded",
        versionId: publicationTestVersionId,
      });
    }));

  it("refuses a current-pointer switch when the ready projection is absent", () =>
    withMigratedTestDatabase(async ({ database }) => {
      const fixture = setupPublicationFixture(database);
      database
        .prepare("DELETE FROM book_version_presentations WHERE version_id = ?")
        .run(publicationTestVersionId);

      await expect(
        publishReadyCandidateForTest({
          bookId: fixture.book.id,
          database,
          nowMs: 12,
        }),
      ).rejects.toMatchObject({ code: "PUBLICATION_STALE" });
      expect(fixture.drafts.requireBook(fixture.book.id)).toMatchObject({
        currentVersionId: null,
        access: "private",
      });
    }));
});
