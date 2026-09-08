import { required } from "../../helpers/required";
import { describe, expect, it } from "vitest";
import { createOpaqueId } from "@/domain/ids";
import type {
  BookDocument,
  ContentBlock,
} from "@/modules/publishing/core/content/book-document.generated";
import { compileBook } from "@/modules/publishing/core/publication/compile-book";
import { documentForPage } from "@/modules/publishing/core/publication/compiled-book";
import { renderSemanticDocument } from "@/modules/publishing/core/publication/render-document";
import { parseTableHtml } from "@/modules/publishing/core/content/table-html";
import { smallBook, headingBlock, paragraphBlock } from "../../helpers/ir-book";
async function render(
  blocks: ContentBlock[],
  resources: BookDocument["resources"] = [],
) {
  const document = smallBook();
  document.blocks = blocks;
  document.resources = resources;
  document.publishing.boundaries = {
    body_start_block_id: required(blocks[0]).id,
  };
  const compiled = compileBook(document);
  const rendered = await renderSemanticDocument({
    document: documentForPage(compiled, required(compiled.pages[0])),
    headingPresentations: compiled.headingByBlockId,
    blockLinkIndex: compiled.blockLinkIndex,
    blockHref: (id) => `/read/1/2#${id}`,
    publishedResourceUrl: (id) => `/books/1/builds/ver_test/resources/${id}`,
    resourceResolution: {
      diagnostics: [],
      references: resources.map((resource) => ({
        originalUrl: resource.path,
        resourceId: resource.id,
      })),
      resources: resources.map((resource) => ({
        absolutePath: "/not-read-by-renderer/" + resource.path,
        id: resource.id,
        originalUrl: resource.path,
        relativePath: resource.path,
      })),
    },
  });
  return { ...rendered, compiled };
}
describe("semantic IR rendering", () => {
  it("renders stable headings, lists, figures, table cells and footnotes", async () => {
    const heading = headingBlock("Published heading");
    const note = createOpaqueId("block"),
      resource = createOpaqueId("resource");
    const image: ContentBlock = {
      id: createOpaqueId("block"),
      type: "image",
      resource_id: resource,
      alt: "Figure description",
      caption: [{ type: "text", text: "Figure caption" }],
    };
    const rendered = await render(
      [
        heading,
        {
          ...paragraphBlock(""),
          content: [
            { type: "emphasis", content: [{ type: "text", text: "Emphasis" }] },
            { type: "footnote_reference", target_id: note },
          ],
        },
        {
          id: createOpaqueId("block"),
          type: "list",
          ordered: false,
          items: [
            { id: createOpaqueId("block"), content: [paragraphBlock("first")] },
            {
              id: createOpaqueId("block"),
              content: [paragraphBlock("second")],
            },
          ],
        },
        {
          id: createOpaqueId("block"),
          type: "table",
          rows: [
            [
              {
                header: true,
                row_span: 1,
                col_span: 1,
                content: [paragraphBlock("Name")],
              },
            ],
            [
              {
                header: false,
                row_span: 1,
                col_span: 1,
                content: [paragraphBlock("Value")],
              },
            ],
          ],
        },
        image,
        {
          id: note,
          type: "footnote",
          content: [paragraphBlock("Footnote body.")],
        },
      ],
      [{ id: resource, path: "assets/figure.png", media_type: "image/png" }],
    );
    expect(rendered.html).toContain(`id="${heading.id}"`);
    expect(rendered.html).toContain("<em>Emphasis</em>");
    expect(rendered.html).toMatch(/<ul[^>]*>[\s\S]*<li/u);
    expect(rendered.html).toMatch(/<table[^>]*>[\s\S]*<th/u);
    expect(rendered.html).toContain(`data-block-id="${image.id}"`);
    expect(rendered.html).toContain(`<figcaption>Figure caption</figcaption>`);
    expect(rendered.html).toContain(
      `src="/books/1/builds/ver_test/resources/${resource}"`,
    );
    expect(rendered.html).toContain('role="doc-noteref"');
    expect(rendered.html).toContain('role="doc-endnote"');
    expect(rendered.html).toContain("Footnote body.");
    expect(rendered.diagnostics).toEqual([]);
  });
  it("pre-renders typed math and keeps invalid or hostile LaTeX readable and inert", async () => {
    const display: ContentBlock = {
      id: createOpaqueId("block"),
      type: "math",
      latex: "\\frac{1}{2}",
    };
    const rendered = await render([
      {
        ...paragraphBlock(""),
        content: [
          { type: "math", latex: "x^2" },
          { type: "math", latex: "\\href{javascript:alert(1)}{x}" },
        ],
      },
      display,
      { id: createOpaqueId("block"), type: "math", latex: "\\notacommand{" },
    ]);
    expect(rendered.html).toContain("katex");
    expect(rendered.html).toContain("katex-display");
    expect(rendered.html).toContain(`data-block-id="${display.id}"`);
    expect(rendered.html).toContain("math-fallback");
    expect(rendered.html).toContain("\\notacommand{");
    expect(rendered.html).not.toContain('href="javascript:');
    expect(rendered.diagnostics).toEqual([
      expect.objectContaining({ code: "MATH_RENDER_FAILED" }),
    ]);
  });
  it("preserves rich structured cells and merged rows without executable markup", async () => {
    const table: ContentBlock = {
      id: createOpaqueId("block"),
      type: "table",
      rows: parseTableHtml(
        '<table><tr><th colspan="2">Cost</th></tr><tr><td><span class="math-inline">x^2</span></td><td><sub>i</sub></td></tr></table>',
        () => {
          throw new Error("No resource");
        },
      ),
    };
    const rendered = await render([table]);
    expect(rendered.html).toContain('colspan="2"');
    expect(rendered.html).toContain("katex");
    expect(rendered.html).toContain("<sub>i</sub>");
    expect(() =>
      parseTableHtml(
        "<table><tr><td><script>alert(1)</script></td></tr></table>",
        () => "",
      ),
    ).toThrow();
  });
  it("recognizes source-table formulas during ingestion without reinterpreting literal text during rendering", async () => {
    const table: ContentBlock = {
      id: createOpaqueId("block"),
      type: "table",
      rows: parseTableHtml(
        "<table><tr><td>literal_under *stars* $x^2$</td><td><code>$not_math$</code></td></tr></table>",
        () => "",
        true,
      ),
    };
    const rendered = await render([table]);
    expect(rendered.html).toContain("literal_under *stars*");
    expect(rendered.html).toContain("katex");
    expect(rendered.html).toContain("$not_math$");
    const literal = await render([
      {
        ...table,
        rows: [
          [
            {
              header: false,
              row_span: 1,
              col_span: 1,
              content: [paragraphBlock("$literal$")],
            },
          ],
        ],
      },
    ]);
    expect(literal.html).toContain("$literal$");
    expect(literal.html).not.toContain("katex");
  });
  it("highlights supported code while keeping unknown languages and hostile code inert", async () => {
    const code = (language: string, text: string): ContentBlock => ({
      id: createOpaqueId("block"),
      type: "code",
      language,
      code: text,
    });
    const blocks = [
      code("ts", "const answer: number = 42"),
      code("unknown-language", "<script>plain & safe</script>"),
      code("text", "plain block"),
    ];
    const rendered = await render(blocks);
    expect(rendered.html).toContain('data-code-language="typescript"');
    expect(rendered.html).toContain('class="shiki');
    expect(rendered.html.match(/data-copy-code/gu)).toHaveLength(3);
    expect(rendered.html).not.toContain(" style=");
    expect(rendered.html).not.toContain("<script>");
    for (const block of blocks)
      expect(rendered.html).toContain(`data-block-id="${block.id}"`);
    expect(rendered.css).toMatch(/\.mw-shiki-[A-Za-z0-9_-]+\{/u);
    expect(rendered.diagnostics).toEqual([
      expect.objectContaining({ code: "CODE_LANGUAGE_UNSUPPORTED" }),
    ]);
  });
  it("marks valid Mermaid for lazy rendering and leaves invalid source readable", async () => {
    const blocks: ContentBlock[] = [
      {
        id: createOpaqueId("block"),
        type: "code",
        language: "mermaid",
        code: "flowchart LR\n  Input --> Output",
      },
      {
        id: createOpaqueId("block"),
        type: "code",
        language: "mermaid",
        code: "flowchart broken",
      },
    ];
    const rendered = await render(blocks);
    expect(rendered.html.match(/data-mermaid-diagram/gu)).toHaveLength(1);
    expect(rendered.html).toContain("flowchart broken");
    expect(rendered.diagnostics).toEqual([
      expect.objectContaining({ code: "MERMAID_RENDER_INVALID" }),
    ]);
  });
  it("renders each textbook container as a labelled region", async () => {
    const kinds = [
      "definition",
      "theorem",
      "proof",
      "example",
      "exercise",
      "solution",
      "note",
      "warning",
    ] as const;
    const rendered = await render(
      kinds.map((kind) => ({
        id: createOpaqueId("block"),
        type: "container",
        kind,
        content: [paragraphBlock(kind + " body.")],
      })),
    );
    for (const kind of kinds) {
      expect(rendered.html).toContain(`data-container-kind="${kind}"`);
      expect(rendered.html).toContain(`aria-label="${kind}"`);
    }
  });
  it("links internal blocks by identity while preserving safe external links", async () => {
    const second = headingBlock("Second");
    second.starts_page = false;
    const rendered = await render([
      headingBlock("First"),
      {
        ...paragraphBlock(""),
        content: [
          {
            type: "link",
            target: { type: "block", block_id: second.id },
            content: [{ type: "text", text: "Continue" }],
          },
          {
            type: "link",
            target: { type: "external", url: "https://example.test/paper" },
            content: [{ type: "text", text: "Reference" }],
          },
        ],
      },
      second,
    ]);
    expect(rendered.html).toContain(`href="/read/1/2#${second.id}"`);
    expect(rendered.html).toContain('href="https://example.test/paper"');
  });
});
