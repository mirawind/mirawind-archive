import { describe, expect, it } from "vitest";
import { contentResourceIds } from "@/modules/publishing/core/content/resource-references";
import type {
  ContentBlock,
  InlineNode,
} from "@/modules/publishing/core/content/book-document.generated";

describe("content resource references", () => {
  it("collects nested images and links in headings, captions, notes, tables, lists and footnotes once", () => {
    const link = (id: string): InlineNode => ({
      type: "link",
      target: { type: "resource", resource_id: id },
      content: [{ type: "text", text: "file" }],
    });
    const paragraph = (id: string): ContentBlock => ({
      type: "paragraph",
      id,
      content: [link(id)],
    });
    const blocks: ContentBlock[] = [
      {
        type: "heading",
        id: "h",
        level: 1,
        content: [
          {
            type: "strong",
            content: [{ type: "image", resource_id: "heading-image", alt: "" }],
          },
        ],
        include_in_toc: true,
        starts_page: true,
        exclude_from_numbering: false,
      },
      {
        type: "image",
        id: "image",
        resource_id: "main-image",
        alt: "",
        caption: [link("caption")],
        notes: [paragraph("note")],
      },
      {
        type: "code",
        id: "code",
        language: "python",
        code: "print(1)",
        caption: [link("code-caption")],
      },
      {
        type: "table",
        id: "table",
        rows: [
          [
            {
              row_span: 1,
              col_span: 1,
              header: false,
              content: [paragraph("cell")],
            },
          ],
        ],
        caption: [link("table-caption")],
        notes: [paragraph("table-note")],
      },
      {
        type: "list",
        id: "list",
        ordered: false,
        items: [{ id: "item", content: [paragraph("list-item")] }],
      },
      {
        type: "quote",
        id: "quote",
        content: [
          {
            type: "footnote",
            id: "footnote",
            content: [paragraph("footnote-image")],
          },
        ],
      },
      paragraph("main-image"),
    ];
    expect(contentResourceIds(blocks)).toEqual([
      "caption",
      "cell",
      "code-caption",
      "footnote-image",
      "heading-image",
      "list-item",
      "main-image",
      "note",
      "table-caption",
      "table-note",
    ]);
  });
});
