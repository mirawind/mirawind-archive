import { required } from "../../helpers/required";
import { describe, expect, it } from "vitest";
import { importMineruContent } from "../../../src/modules/publishing/core/preparation/mineru-content";
import { compileBook } from "../../../src/modules/publishing/core/publication/compile-book";
import { documentForPage } from "../../../src/modules/publishing/core/publication/compiled-book";
import { renderSemanticDocument } from "../../../src/modules/publishing/core/publication/render-document";
import { buildDocumentManifest } from "../../../src/modules/publishing/core/publication/manifest";
import { buildSearchRowsForBlocks } from "../../../src/modules/publishing/core/publication/search-model";
import type { HeadingBlock } from "../../../src/modules/publishing/core/content/book-document.generated";
import { blockText } from "../../../src/modules/publishing/core/content/content-tree";
const text = (content: string) => ({ type: "text", content });
const fixture = [
  [
    { type: "title", content: { level: 1, title_content: [text("Limits")] } },
    {
      type: "paragraph",
      content: {
        paragraph_content: [
          text("Consider "),
          { type: "equation_inline", content: "x^2" },
        ],
      },
    },
    {
      type: "title",
      content: { level: 2, title_content: [text("Supplement")] },
    },
    { type: "title", content: { level: 3, title_content: [text("Detail")] } },
    {
      type: "code",
      content: {
        code_content: [text("print(1)")],
        code_language: "python",
        code_caption: [],
      },
    },
    { type: "title", content: { level: 2, title_content: [text("Method")] } },
    {
      type: "table",
      content: {
        html: "<table><tr><th>Variable</th><th>Value</th></tr><tr><td>x</td><td>1</td></tr></table>",
        table_caption: [text("Values")],
        table_footnote: [],
      },
    },
    {
      type: "page_footnote",
      content: { page_footnote_content: [text("A source note.")] },
    },
  ],
];
describe("IR publication", () => {
  it("keeps a literal less-than comparison next to source superscript tags", () => {
    const imported = importMineruContent(
      [
        [
          {
            type: "paragraph",
            content: {
              paragraph_content: [text("Q<sup>d</sup> <Q<sup>s</sup>")],
            },
          },
        ],
      ],
      { bookId: 1, nowMs: 1000, title: "Book" },
    );
    const block = imported.book.blocks[0];
    if (!block || block.type !== "paragraph")
      throw new Error("PARAGRAPH_MISSING");
    expect(blockText(block)).toBe("Qd <Qs");
    expect(
      block.content.filter((node) => node.type === "superscript"),
    ).toHaveLength(2);
  });
  it("preserves inline markup from JSON as typed content while keeping code literal", async () => {
    const book = importMineruContent(
      [
        [
          {
            type: "title",
            content: { level: 1, title_content: [text("A <sup>2</sup>")] },
          },
          {
            type: "paragraph",
            content: {
              paragraph_content: [
                text("x<sub>i</sub> and <strong>bold</strong>"),
              ],
            },
          },
          {
            type: "code",
            content: {
              code_language: "html",
              code_content: [text("<sub>literal</sub>")],
              code_caption: [],
            },
          },
        ],
      ],
      { bookId: 1, nowMs: 1000, title: "Book" },
    ).book;
    const compiled = compileBook(book);
    const rendered = await renderSemanticDocument({
      document: documentForPage(compiled, required(compiled.pages[0])),
      blockLinkIndex: compiled.blockLinkIndex,
      headingPresentations: compiled.headingByBlockId,
      publishedResourceUrl: () => "",
      resourceResolution: { resources: [], references: [], diagnostics: [] },
    });
    expect(rendered.html).toContain("<sup>2</sup>");
    expect(rendered.html).toContain("<sub>i</sub>");
    expect(rendered.html).toContain("<strong>bold</strong>");
    expect(book.blocks[2]).toMatchObject({
      type: "code",
      code: "<sub>literal</sub>",
    });
  });
  it("publishes one structured document as semantic HTML, navigation, manifest and searchable text", async () => {
    const imported = importMineruContent(fixture, {
      bookId: 1,
      nowMs: 1000,
      title: "Book",
    });
    imported.book.publishing.numbering = "generated";
    (imported.book.blocks[2] as HeadingBlock).exclude_from_numbering = true;
    const book = compileBook(imported.book);
    const rendered = await renderSemanticDocument({
      document: documentForPage(book, required(book.pages[0])),
      blockLinkIndex: book.blockLinkIndex,
      headingPresentations: book.headingByBlockId,
      publishedResourceUrl: () => {
        throw new Error("Unexpected resource");
      },
      resourceResolution: { resources: [], references: [], diagnostics: [] },
    });
    expect(rendered.html).toContain("heading-number");
    expect(rendered.html).toContain("1.1");
    expect(rendered.html).not.toContain("1.2");
    expect(rendered.html).toContain("katex");
    expect(rendered.html).toContain("<table>");
    expect(rendered.html).toContain("A source note.");
    const manifest = buildDocumentManifest({
      book,
      bookId: 1,
      createdAt: "2026-09-07T00:00:00.000Z",
      resources: [],
      versionId: `ver_${"a".repeat(24)}`,
    });
    expect(manifest.schema_version).toBe(5);
    expect(manifest.source_updated_at).toBe(1000);
    expect(
      (
        manifest.toc as {
          number: string | null;
        }[]
      ).map((node) => node.number),
    ).toEqual(["1", null, null, "1.1"]);
    const rows = buildSearchRowsForBlocks({
      authors: [],
      blocks: book.document.blocks,
      book,
      bookId: 1,
      cursor: { currentHeading: "", nextOrdinal: 0 },
      title: "Book",
      versionId: `ver_${"a".repeat(24)}`,
    });
    expect(rows.rows.some((row) => row.heading === "1.1 Method")).toBe(true);
  });
});
