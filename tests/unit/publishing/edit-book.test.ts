import { required } from "../../helpers/required";
import { describe, expect, it } from "vitest";
import { smallBook } from "../../helpers/ir-book";
import { createOpaqueId } from "@/domain/ids";
import type {
  ContentBlock,
  InlineNode,
  TableBlock,
} from "@/modules/publishing/core/content/book-document.generated";
import {
  blockEditorText,
  inlineEditorText,
  parseInlineEditorText,
} from "@/modules/publishing/core/content/editor-text";
import { editDraftInMemory } from "../../helpers/document-edits";
import { contentEntries } from "@/modules/publishing/core/content/content-tree";
describe("structured block editing", () => {
  it("assigns new identities to inserted list items without shifting existing identities", () => {
    const book = smallBook();
    const items = ["Alpha", "Beta"].map((text) => ({
      id: createOpaqueId("block"),
      content: [
        {
          id: createOpaqueId("block"),
          type: "paragraph" as const,
          content: [
            { type: "text" as const, text: text.slice(0, 2) },
            { type: "text" as const, text: text.slice(2) },
          ],
        },
      ],
    }));
    const list: ContentBlock = {
      id: createOpaqueId("block"),
      type: "list",
      ordered: false,
      items,
    };
    book.blocks.push(list);
    const edited = editDraftInMemory(
      book,
      { blocks: [{ block_id: list.id, markdown: "- New\n- Alpha\n- Beta" }] },
      1000,
      2000,
    );
    const result = edited.blocks.at(-1);
    if (result?.type !== "list") throw new Error("List missing");
    expect(result.items.slice(1).map((item) => item.id)).toEqual(
      items.map((item) => item.id),
    );
    expect(result.items.slice(1).map((item) => item.content[0]?.id)).toEqual(
      items.map((item) => item.content[0]?.id),
    );
    expect(items.map((item) => item.id)).not.toContain(result.items[0]?.id);
  });
  it("retains cell identities when a table row is inserted before existing rows", () => {
    const book = smallBook();
    const table: TableBlock = {
      id: createOpaqueId("block"),
      type: "table",
      rows: ["Alpha", "Beta"].map((text) => [
        {
          header: false,
          row_span: 1,
          col_span: 1,
          content: [
            {
              id: createOpaqueId("block"),
              type: "paragraph",
              content: [{ type: "text", text }],
            },
          ],
        },
      ]),
    };
    book.blocks.push(table);
    const edited = editDraftInMemory(
      book,
      {
        blocks: [
          {
            block_id: table.id,
            markdown:
              "<table><tr><td>New</td></tr><tr><td>Alpha</td></tr><tr><td>Beta</td></tr></table>",
          },
        ],
      },
      1000,
      2000,
    );
    const result = edited.blocks.at(-1);
    if (result?.type !== "table") throw new Error("Table missing");
    expect(result.rows.slice(1).map((row) => row[0]?.content[0]?.id)).toEqual(
      table.rows.map((row) => row[0]?.content[0]?.id),
    );
  });
  it("round trips nested emphasis, math, scripts, underline, links, and footnote references", () => {
    const book = smallBook();
    const note = createOpaqueId("block");
    book.blocks.push({
      id: note,
      type: "footnote",
      content: [
        {
          id: createOpaqueId("block"),
          type: "paragraph",
          content: [{ type: "text", text: "Note" }],
        },
      ],
    });
    const content: InlineNode[] = [
      {
        type: "strong",
        content: [
          { type: "underline", content: [{ type: "text", text: "A < B" }] },
        ],
      },
      { type: "text", text: " with " },
      { type: "subscript", content: [{ type: "math", latex: "x^2" }] },
      { type: "superscript", content: [{ type: "code", code: "n" }] },
      {
        type: "link",
        target: { type: "block", block_id: required(book.blocks[0]).id },
        content: [{ type: "text", text: "Chapter" }],
      },
      { type: "footnote_reference", target_id: note },
    ];
    const text = inlineEditorText(content, book);
    expect(parseInlineEditorText(text, book)).toEqual(content);
  });
  it("retains nested block IDs, code captions, image notes and table spans on ordinary editing", () => {
    const book = smallBook();
    const code: ContentBlock = {
      id: createOpaqueId("block"),
      type: "code",
      language: "js",
      code: "x()",
      caption: [{ type: "text", text: "Example" }],
    };
    const quote: ContentBlock = {
      id: createOpaqueId("block"),
      type: "quote",
      content: [code],
    };
    const table: TableBlock = {
      id: createOpaqueId("block"),
      type: "table",
      caption: [{ type: "text", text: "Caption" }],
      rows: [
        [
          {
            header: true,
            row_span: 1,
            col_span: 2,
            content: [
              {
                id: createOpaqueId("block"),
                type: "paragraph",
                content: [
                  {
                    type: "underline",
                    content: [{ type: "text", text: "Value" }],
                  },
                ],
              },
            ],
          },
        ],
      ],
    };
    book.blocks.push(quote, table);
    for (const block of [quote, table]) {
      const edited = editDraftInMemory(
        book,
        {
          blocks: [
            { block_id: block.id, markdown: blockEditorText(block, book) },
          ],
        },
        book.updated_at,
        2000,
      );
      expect(edited.updated_at).toBe(book.updated_at);
      expect(edited).toEqual(book);
      expect(
        [...contentEntries(edited.blocks)].map((entry) => entry.node.id),
      ).toEqual([...contentEntries(book.blocks)].map((entry) => entry.node.id));
    }
  });
  it("edits nested tables without discarding unrelated content or identities", () => {
    const book = smallBook();
    const cell = {
      id: createOpaqueId("block"),
      type: "paragraph" as const,
      content: [{ type: "text" as const, text: "Old value" }],
    };
    const table: TableBlock = {
      id: createOpaqueId("block"),
      type: "table",
      caption: [{ type: "text", text: "Table caption" }],
      rows: [[{ header: false, row_span: 1, col_span: 2, content: [cell] }]],
    };
    const quote: ContentBlock = {
      id: createOpaqueId("block"),
      type: "quote",
      content: [table],
    };
    book.blocks.push(quote);
    const edited = editDraftInMemory(
      book,
      {
        blocks: [
          {
            block_id: quote.id,
            markdown: blockEditorText(quote, book).replace(
              "Old value",
              "New value",
            ),
          },
        ],
      },
      book.updated_at,
      2000,
    );
    const result = edited.blocks.at(-1);
    expect(result).toEqual({
      ...quote,
      content: [
        {
          ...table,
          rows: [
            [
              {
                ...required(table.rows[0])[0],
                content: [
                  { ...cell, content: [{ type: "text", text: "New value" }] },
                ],
              },
            ],
          ],
        },
      ],
    });
    expect(edited.updated_at).toBe(2000);
  });
  it("rejects executable HTML, missing resources and invalid internal references without mutating the draft", () => {
    const book = smallBook();
    const previous = structuredClone(book);
    for (const text of [
      "<script>alert(1)</script>",
      "![image](missing.png)",
      "[link](javascript:alert)",
      "[link](#blk_missingmissingmissing000)",
    ])
      expect(() =>
        editDraftInMemory(
          book,
          {
            blocks: [{ block_id: required(book.blocks[1]).id, markdown: text }],
          },
          1000,
          2000,
        ),
      ).toThrow();
    expect(book).toEqual(previous);
  });
});
