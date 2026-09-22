import { describe, expect, it, vi } from "vitest";
import { createOpaqueId } from "@/domain/ids";
import { parseDraftEdit } from "@/modules/publishing/core/content/edit-book";
import { prepareDraftEdit } from "@/modules/publishing/core/content/prepare-edit";
import { validateBookDocument } from "@/modules/publishing/core/content/book-document";
import { blockEditorText } from "@/modules/publishing/core/content/editor-text";
import {
  editContextForBook,
  editDraftInMemory,
} from "../../helpers/document-edits";
import { headingBlock, paragraphBlock, smallBook } from "../../helpers/ir-book";
import { required } from "../../helpers/required";
import type { ContentBlock } from "@/modules/publishing/core/content/book-document.generated";
import { contentEntries } from "@/modules/publishing/core/content/content-tree";

const resourceId = "res_block_edit_fixture_0001";
function blockVariants(): Record<ContentBlock["type"], ContentBlock> {
  return {
    heading: headingBlock("Original", 2),
    paragraph: paragraphBlock("Original"),
    code: {
      id: createOpaqueId("block"),
      type: "code",
      language: "text",
      code: "Original",
    },
    math: { id: createOpaqueId("block"), type: "math", latex: "Original" },
    quote: {
      id: createOpaqueId("block"),
      type: "quote",
      content: [paragraphBlock("Original")],
    },
    container: {
      id: createOpaqueId("block"),
      type: "container",
      kind: "note",
      content: [paragraphBlock("Original")],
    },
    footnote: {
      id: createOpaqueId("block"),
      type: "footnote",
      content: [paragraphBlock("Original")],
    },
    list: {
      id: createOpaqueId("block"),
      type: "list",
      ordered: false,
      items: [
        { id: createOpaqueId("block"), content: [paragraphBlock("Original")] },
      ],
    },
    image: {
      id: createOpaqueId("block"),
      type: "image",
      resource_id: resourceId,
      alt: "Original",
    },
    table: {
      id: createOpaqueId("block"),
      type: "table",
      rows: [
        [
          {
            header: false,
            row_span: 1,
            col_span: 1,
            content: [paragraphBlock("Original")],
          },
        ],
      ],
    },
    divider: { id: createOpaqueId("block"), type: "divider" },
  };
}

describe("scoped block edit preparation", () => {
  it("allows clearing paragraph content without deleting its identity, but not an empty heading", () => {
    const book = smallBook(),
      paragraph = required(book.blocks[1]);
    const result = editDraftInMemory(
      book,
      { blocks: [{ block_id: paragraph.id, markdown: "" }] },
      1000,
      2000,
    );
    expect(result.blocks[1]).toEqual({
      id: paragraph.id,
      type: "paragraph",
      content: [],
    });
    expect(validateBookDocument(result)).toBe(result);
    expect(() =>
      editDraftInMemory(
        book,
        { blocks: [{ block_id: required(book.blocks[0]).id, markdown: "" }] },
        1000,
        2000,
      ),
    ).toThrow();
  });
  it.each(Object.entries(blockVariants()))(
    "edits %s through the common block command with stable identities",
    (_type, block) => {
      const book = smallBook();
      book.resources = [
        { id: resourceId, path: "assets/image.png", media_type: "image/png" },
      ];
      book.blocks.push(block);
      const oldText = blockEditorText(block, book),
        text =
          block.type === "divider"
            ? oldText
            : oldText.replace("Original", "Changed");
      const result = editDraftInMemory(
        book,
        { blocks: [{ block_id: block.id, markdown: text }] },
        1000,
        2000,
      );
      expect(blockEditorText(required(result.blocks.at(-1)), result)).toBe(
        text,
      );
      expect(
        [...contentEntries(result.blocks)].map((entry) => entry.node.id),
      ).toEqual([...contentEntries(book.blocks)].map((entry) => entry.node.id));
      expect(result.updated_at).toBe(block.type === "divider" ? 1000 : 2000);
      expect(validateBookDocument(result)).toBe(result);
    },
  );
  it("edits a list item through the same identity path", () => {
    const book = smallBook(),
      child = paragraphBlock("Original"),
      item = { id: createOpaqueId("block"), content: [child] };
    book.blocks.push({
      id: createOpaqueId("block"),
      type: "list",
      ordered: false,
      items: [item],
    });
    const result = editDraftInMemory(
      book,
      { blocks: [{ block_id: item.id, markdown: "Changed" }] },
      1000,
      2000,
    );
    expect(result.blocks.at(-1)).toMatchObject({
      type: "list",
      items: [
        {
          id: item.id,
          content: [{ id: child.id, content: [{ text: "Changed" }] }],
        },
      ],
    });
  });
  it("does not request body roots or an outline for document metadata and numbering edits", () => {
    const context = editContextForBook(smallBook());
    context.rootForBlock = vi.fn(() => {
      throw new Error("Unexpected root read");
    });
    context.headingRoots = vi.fn(() => {
      throw new Error("Unexpected outline read");
    });
    const result = prepareDraftEdit(
      context,
      parseDraftEdit({ metadata: { title: "Changed" }, numbering: "none" }),
    );
    expect(result.header.metadata.title).toBe("Changed");
    expect(result.header.publishing.numbering).toBe("none");
    expect(result.roots).toEqual([]);
    expect(result.changed).toBe(true);
  });
  it("edits a nested heading and paragraph through the same root without reading unrelated roots", () => {
    const book = smallBook(),
      heading = headingBlock("Inside", 2),
      paragraph = paragraphBlock("Inside body");
    const root = {
      id: createOpaqueId("block"),
      type: "quote" as const,
      content: [heading, paragraph],
    };
    book.blocks.push(root);
    const context = editContextForBook(book),
      load = vi.spyOn(context, "rootForBlock"),
      outline = vi.spyOn(context, "headingRoots");
    const result = prepareDraftEdit(
      context,
      parseDraftEdit({
        blocks: [
          { block_id: heading.id, markdown: "New title" },
          { block_id: paragraph.id, markdown: "New body" },
        ],
      }),
    );
    expect(load.mock.calls.map(([id]) => id)).toEqual([
      heading.id,
      paragraph.id,
    ]);
    expect(outline).not.toHaveBeenCalled();
    expect(result.roots).toHaveLength(1);
    expect(result.roots[0]?.block).toMatchObject({
      id: root.id,
      content: [
        { id: heading.id, content: [{ text: "New title" }] },
        { id: paragraph.id, content: [{ text: "New body" }] },
      ],
    });
    expect(book.blocks.at(-1)).toEqual(root);
  });
  it("loads ordered headings only for structural changes and checks neighboring levels", () => {
    const book = smallBook(),
      second = headingBlock("Child", 2);
    book.blocks.push(second, paragraphBlock("Other body"));
    const context = editContextForBook(book),
      outline = vi.spyOn(context, "headingRoots"),
      load = vi.spyOn(context, "rootForBlock");
    expect(() =>
      prepareDraftEdit(
        context,
        parseDraftEdit({ blocks: [{ block_id: second.id, level: 4 }] }),
      ),
    ).toThrow();
    expect(load.mock.calls).toEqual([[second.id]]);
    expect(outline).toHaveBeenCalledTimes(1);
    const result = editDraftInMemory(
      book,
      {
        blocks: [
          { block_id: second.id, level: 1, starts_page: true, alias: "child" },
        ],
      },
      1000,
      1001,
    );
    expect(validateBookDocument(result)).toBe(result);
  });
  it("preserves nested heading identity and settings when editing a containing block", () => {
    const book = smallBook(),
      heading = headingBlock("Inside", 2);
    heading.exclude_from_numbering = true;
    heading.include_in_toc = false;
    heading.source_number = "2.1";
    const root = {
      id: createOpaqueId("block"),
      type: "quote" as const,
      content: [heading, paragraphBlock("Body")],
    };
    book.blocks.push(root);
    const text = blockEditorText(root, book).replace("Inside", "Changed");
    const result = editDraftInMemory(
      book,
      { blocks: [{ block_id: root.id, markdown: text }] },
      1000,
      1001,
    );
    expect(result.blocks.at(-1)).toMatchObject({
      id: root.id,
      content: [
        { ...heading, content: [{ type: "text", text: "Changed" }] },
        root.content[1],
      ],
    });
    expect(validateBookDocument(result)).toBe(result);
  });
  it.each(["footnote", "container", "list_item"] as const)(
    "preserves nested heading semantics through %s editing",
    (kind) => {
      const book = smallBook(),
        heading = headingBlock("Inside", 2),
        content = [heading, paragraphBlock("Old body")];
      const id = createOpaqueId("block");
      if (kind === "list_item")
        book.blocks.push({
          id: createOpaqueId("block"),
          type: "list",
          ordered: false,
          items: [{ id, content }],
        });
      else if (kind === "container")
        book.blocks.push({ id, type: "container", kind: "note", content });
      else book.blocks.push({ id, type: "footnote", content });
      const selected = required(
        [...contentEntries(book.blocks)].find((entry) => entry.node.id === id),
      ).node;
      const result = editDraftInMemory(
        book,
        {
          blocks: [
            {
              block_id: id,
              markdown: blockEditorText(selected, book).replace(
                "Old body",
                "New body",
              ),
            },
          ],
        },
        1000,
        2000,
      );
      expect(
        required(
          [...contentEntries(result.blocks)].find(
            (entry) => entry.node.id === heading.id,
          ),
        ).node,
      ).toEqual(heading);
      expect(validateBookDocument(result)).toBe(result);
    },
  );
  it("rejects parent/child edits and heading-only properties on other block types", () => {
    const book = smallBook(),
      child = paragraphBlock("Child"),
      root = {
        id: createOpaqueId("block"),
        type: "quote" as const,
        content: [child],
      };
    book.blocks.push(root);
    expect(() =>
      editDraftInMemory(
        book,
        {
          blocks: [
            { block_id: root.id, markdown: "> Parent" },
            { block_id: child.id, markdown: "Child" },
          ],
        },
        1000,
        1001,
      ),
    ).toThrow("A batch cannot edit both a container and its descendants.");
    expect(() =>
      editDraftInMemory(
        book,
        { blocks: [{ block_id: required(book.blocks[1]).id, level: 1 }] },
        1000,
        1001,
      ),
    ).toThrow();
  });
  it("checks references across the final batch, allowing a deleted target when its link is removed too", () => {
    const book = smallBook(),
      target = paragraphBlock("Target"),
      root = {
        id: createOpaqueId("block"),
        type: "quote" as const,
        content: [target],
      };
    const reference = paragraphBlock("Reference");
    reference.content = [
      {
        type: "link",
        target: { type: "block", block_id: target.id },
        content: [{ type: "text", text: "Reference" }],
      },
    ];
    book.blocks.push(root, reference);
    expect(() =>
      editDraftInMemory(
        book,
        { blocks: [{ block_id: root.id, markdown: "Replacement" }] },
        1000,
        1001,
      ),
    ).toThrow();
    const result = editDraftInMemory(
      book,
      {
        blocks: [
          { block_id: root.id, markdown: "Replacement" },
          { block_id: reference.id, markdown: "No link" },
        ],
      },
      1000,
      1001,
    );
    expect(validateBookDocument(result)).toBe(result);
  });
  it("rejects nested page starts, duplicate aliases and deleted boundary targets", () => {
    const book = smallBook(),
      heading = headingBlock("Nested", 2),
      root = {
        id: createOpaqueId("block"),
        type: "quote" as const,
        content: [heading],
      };
    book.blocks.push(root);
    expect(() =>
      editDraftInMemory(
        book,
        { blocks: [{ block_id: heading.id, starts_page: true }] },
        1000,
        2000,
      ),
    ).toThrow();
    const second = headingBlock("Second");
    book.blocks.push(second);
    expect(() =>
      editDraftInMemory(
        book,
        {
          blocks: [
            { block_id: required(book.blocks[0]).id, alias: "same" },
            { block_id: second.id, alias: "same" },
          ],
        },
        1000,
        2000,
      ),
    ).toThrow();
    book.publishing.boundaries.appendix_start_block_id = heading.id;
    expect(() =>
      editDraftInMemory(
        book,
        { blocks: [{ block_id: root.id, markdown: "Replacement" }] },
        1000,
        2000,
      ),
    ).toThrow();
    const result = editDraftInMemory(
      book,
      {
        boundaries: { appendix_start_block_id: second.id },
        blocks: [{ block_id: root.id, markdown: "Replacement" }],
      },
      1000,
      2000,
    );
    expect(validateBookDocument(result)).toBe(result);
  });
});
