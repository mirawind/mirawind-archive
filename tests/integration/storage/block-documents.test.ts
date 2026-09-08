import { required } from "../../helpers/required";
import { describe, expect, it, vi } from "vitest";
import { DocumentRepository } from "@/modules/publishing/adapters/sqlite/documents";
import { DraftRepository } from "@/modules/publishing/adapters/sqlite/drafts";
import {
  smallBook,
  headingBlock,
  paragraphBlock,
  installIrDraft,
} from "../../helpers/ir-book";
import { createOpaqueId } from "@/domain/ids";
import { BuildRepository } from "@/modules/publishing/adapters/sqlite/builds";
import { JobRepository } from "@/modules/publishing/adapters/sqlite/jobs";
import {
  requestPreviewBuild,
  saveDocument,
} from "@/modules/publishing/adapters/sqlite/save-document";
import { withMigratedTestDatabase } from "../../helpers/database";

describe("transactional block documents", () => {
  it("exposes nested headings in document order and saves them without losing their container", () =>
    withMigratedTestDatabase(({ database }) => {
      const id = new DraftRepository(database).createBook({
        title: "Book",
        nowMs: 1,
      }).id;
      const book = smallBook(id),
        nested = headingBlock("Nested", 2),
        documents = new DocumentRepository(database);
      book.blocks.push({
        id: createOpaqueId("block"),
        type: "quote",
        content: [nested, paragraphBlock("Inside")],
      });
      documents.insert(book);
      expect(documents.view(id).structure.map((item) => item.block_id)).toEqual(
        [required(book.blocks[0]).id, nested.id],
      );
      documents.edit({
        bookId: id,
        expectedUpdatedAt: 1000,
        nowMs: 1000,
        requestId: "nested_heading_edit_01",
        patch: {
          changes: [
            {
              block_id: nested.id,
              title_markdown: "Revised",
              exclude_from_numbering: true,
            },
          ],
        },
        onChanged() {},
      });
      expect(documents.view(id).structure[1]).toMatchObject({
        block_id: nested.id,
        title_markdown: "Revised",
        exclude_from_numbering: true,
      });
      expect(documents.read(id).blocks[2]).toMatchObject({
        type: "quote",
        content: [{ id: nested.id }, { type: "paragraph" }],
      });
    }));

  it("checks cross-root links and rejects deleting a referenced child atomically", () =>
    withMigratedTestDatabase(({ database }) => {
      const id = new DraftRepository(database).createBook({
        title: "Book",
        nowMs: 1,
      }).id;
      const book = smallBook(id),
        child = paragraphBlock("Referenced"),
        documents = new DocumentRepository(database);
      const quote = {
        id: createOpaqueId("block"),
        type: "quote" as const,
        content: [child],
      };
      book.blocks.push(quote);
      documents.insert(book);
      const edit = (blockId: string, markdown: string, expected = 1000) =>
        documents.edit({
          bookId: id,
          expectedUpdatedAt: expected,
          nowMs: expected,
          requestId: createOpaqueId("job"),
          patch: { block: { block_id: blockId, markdown } },
          onChanged() {},
        });
      expect(
        edit(required(book.blocks[1]).id, `[Reference](#${child.id})`),
      ).toEqual({ updated_at: 1001 });
      const linked = documents.read(id);
      expect(() => edit(quote.id, "Replace entire quote", 1001)).toThrow(
        "The edit would remove referenced content.",
      );
      expect(() =>
        edit(
          required(book.blocks[1]).id,
          `[Missing](#${createOpaqueId("block")})`,
          1001,
        ),
      ).toThrow();
      expect(documents.read(id)).toEqual(linked);
      expect(edit(child.id, "Changed target", 1001)).toEqual({
        updated_at: 1002,
      });
      expect(documents.block(id, child.id).markdown).toBe("Changed target");
    }));

  it("coalesces queued builds, reuses running input and cancels only stale work for the edited book", () =>
    withMigratedTestDatabase(async ({ database }, { layout }) => {
      const fixture = await installIrDraft(database, layout),
        other = await installIrDraft(database, layout);
      const jobs = new JobRepository(database),
        builds = new BuildRepository(database);
      const save = (expected: number, text: string) =>
        saveDocument({
          bookId: fixture.book.book_id,
          database,
          expectedUpdatedAt: expected,
          nowMs: expected,
          requestId: createOpaqueId("job"),
          patch: {
            block: {
              block_id: required(fixture.book.blocks[1]).id,
              markdown: text,
            },
          },
        });
      save(1000, "First edit");
      save(1001, "Second edit");
      expect(builds.findCurrent(fixture.book.book_id)).toMatchObject({
        id: fixture.build.id,
        sourceUpdatedAt: 1002,
      });
      const otherJob = required(
        jobs.claimNext({ leaseOwner: "test", nowMs: 1002 }),
      );
      expect(otherJob.bookId).toBe(other.book.book_id);
      requestPreviewBuild({
        bookId: fixture.book.book_id,
        database,
        expectedUpdatedAt: 1002,
        nowMs: 1003,
      });
      expect(jobs.get(otherJob.id)?.cancellationRequestedAtMs).toBeNull();
      jobs.fail(otherJob.id, {
        errorCode: "TEST_FINISHED",
        errorClass: "content",
        nowMs: 1004,
      });
      const running = required(
        jobs.claimNext({ leaseOwner: "test", nowMs: 1004 }),
      );
      expect(running.id).toBe(fixture.build.jobId);
      expect(
        requestPreviewBuild({
          bookId: fixture.book.book_id,
          database,
          expectedUpdatedAt: 1002,
          nowMs: 1004,
        }).jobId,
      ).toBe(running.id);
      save(1002, "Third edit");
      expect(jobs.get(running.id)?.cancellationRequestedAtMs).toBe(1002);
      expect(builds.findCurrent(fixture.book.book_id)).toMatchObject({
        sourceUpdatedAt: 1003,
        state: "building",
      });
      expect(builds.findCurrent(fixture.book.book_id)?.jobId).not.toBe(
        running.id,
      );
    }));

  it("updates only the edited root, preserves identity and replays a network retry", () =>
    withMigratedTestDatabase(({ database }) => {
      const id = new DraftRepository(database).createBook({
        title: "Book",
        nowMs: 1,
      }).id;
      const book = smallBook(id, 1000),
        documents = new DocumentRepository(database);
      documents.insert(book);
      database.exec(
        "CREATE TABLE changed_blocks(id TEXT); CREATE TRIGGER record_block_update AFTER UPDATE ON book_blocks BEGIN INSERT INTO changed_blocks VALUES (NEW.id); END;",
      );
      const target = required(book.blocks[1]);
      const onChanged = vi.fn();
      const input = {
        bookId: id,
        expectedUpdatedAt: 1000,
        nowMs: 900,
        requestId: "save_request_00000001",
        patch: { block: { block_id: target.id, markdown: "Updated body" } },
        onChanged,
      };
      expect(documents.edit(input)).toEqual({ updated_at: 1001 });
      expect(documents.edit(input)).toEqual({ updated_at: 1001 });
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(database.prepare("SELECT id FROM changed_blocks").all()).toEqual([
        { id: target.id },
      ]);
      expect(documents.read(id).blocks[0]).toEqual(book.blocks[0]);
      expect(documents.block(id, target.id)).toMatchObject({
        block_id: target.id,
        markdown: "Updated body",
        updated_at: 1001,
      });
      expect(() =>
        documents.edit({ ...input, requestId: "save_request_00000002" }),
      ).toThrow();
      expect(() =>
        documents.edit({
          ...input,
          patch: { block: { block_id: target.id, markdown: "different" } },
        }),
      ).toThrow();
    }));
  it("does not advance a no-op and rolls back content when scheduling fails", () =>
    withMigratedTestDatabase(({ database }) => {
      const id = new DraftRepository(database).createBook({
        title: "Book",
        nowMs: 1,
      }).id;
      const book = smallBook(id, 1000),
        documents = new DocumentRepository(database);
      documents.insert(book);
      expect(
        documents.edit({
          bookId: id,
          expectedUpdatedAt: 1000,
          nowMs: 1000,
          requestId: "save_request_00000001",
          patch: {},
          onChanged() {
            throw new Error("not called");
          },
        }),
      ).toEqual({ updated_at: 1000 });
      expect(() =>
        documents.edit({
          bookId: id,
          expectedUpdatedAt: 1000,
          nowMs: 1000,
          requestId: "save_request_00000002",
          patch: { metadata: { title: "Changed" } },
          onChanged() {
            throw new Error("schedule failed");
          },
        }),
      ).toThrow("schedule failed");
      expect(documents.read(id)).toEqual(book);
      expect(
        database
          .prepare("SELECT count(*) AS count FROM document_commands")
          .get(),
      ).toEqual({ count: 1 });
    }));
});
