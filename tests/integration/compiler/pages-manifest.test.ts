import { required } from "../../helpers/required";
import { describe, expect, it } from "vitest";
import { buildDocumentManifest } from "@/modules/publishing/core/publication/manifest";
import { compileBook } from "@/modules/publishing/core/publication/compile-book";
import { buildSearchSpool } from "@/modules/publishing/core/publication/search-model";
import {
  documentForPage,
  pageBlockIds,
  pageMetadata,
} from "@/modules/publishing/core/publication/compiled-book";
import { renderSemanticDocument } from "@/modules/publishing/core/publication/render-document";
import { headingBlock, paragraphBlock, smallBook } from "../../helpers/ir-book";
const versionId = "ver_pages_manifest_test_0001";
function fixture(numbering: "generated" | "none" | "source" = "generated") {
  const document = smallBook();
  const headings = [
    "Introduction",
    "Chapter",
    "Details",
    "Appendix",
    "Afterword",
  ].map((title, index) => ({
    ...headingBlock(title, index === 2 ? 2 : 1),
    include_in_toc: index !== 2,
    source_number: required(["P", "C1", "C1.1", "A", "E"][index]),
  }));
  document.blocks = headings.flatMap((heading) => [
    heading,
    paragraphBlock("Body."),
  ]);
  document.publishing.numbering = numbering;
  document.publishing.boundaries = {
    body_start_block_id: required(headings[1]).id,
    appendix_start_block_id: required(headings[3]).id,
    backmatter_start_block_id: required(headings[4]).id,
  };
  return compileBook(document);
}
const manifestFor = (book: ReturnType<typeof compileBook>) =>
  buildDocumentManifest({
    book,
    bookId: 1,
    createdAt: "2026-09-07T00:00:00.000Z",
    resources: [],
    versionId,
  });
describe("IR pages and manifest", () => {
  it("splits at declared headings and shares role-aware numbering with search", () => {
    const book = fixture();
    expect(book.pages.map((page) => pageMetadata(book, page).title)).toEqual([
      "Introduction",
      "1 Chapter",
      "Appendix",
      "Afterword",
    ]);
    expect(book.headings.map((heading) => heading.number)).toEqual([
      null,
      "1",
      "1.1",
      null,
      null,
    ]);
    const search = buildSearchSpool({
      authors: [],
      book,
      bookId: 1,
      title: "Book",
      versionId,
    });
    expect(
      search.shortRows
        .filter((row) => row.kind === "heading")
        .map((row) => row.normalizedText),
    ).toEqual([
      "Introduction",
      "1 Chapter",
      "1.1 Details",
      "Appendix",
      "Afterword",
    ]);
    const ids = book.pages.flatMap((page) => pageBlockIds(book, page));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(book.document.blocks.length);
  });
  it("rebases a nested body when a later shallower heading appears", () => {
    const document = smallBook();
    const headings = [
      headingBlock("Preface"),
      headingBlock("Body", 2),
      headingBlock("Detail", 3),
      headingBlock("Major"),
    ];
    document.blocks = headings;
    document.publishing.numbering = "generated";
    document.publishing.boundaries.body_start_block_id = required(
      headings[1],
    ).id;
    expect(
      compileBook(document).headings.map((heading) => heading.number),
    ).toEqual([null, "1", "1.1", "2"]);
  });
  it.each([1, 2, 3, 4])("starts level %i body numbering at one", (level) => {
    const document = smallBook();
    const headings = Array.from({ length: level }, (_, index) =>
      headingBlock("Heading", index + 1),
    );
    document.blocks = headings;
    document.publishing.numbering = "generated";
    document.publishing.boundaries.body_start_block_id = required(
      headings.at(-1),
    ).id;
    expect(
      compileBook(document).headings.map((heading) => heading.number),
    ).toEqual([...Array.from({ length: level - 1 }, () => null), "1"]);
  });
  it("preserves source numbers across roles and suppresses every number in none mode", () => {
    expect(fixture("source").headings.map((heading) => heading.number)).toEqual(
      ["P", "C1", "C1.1", "A", "E"],
    );
    expect(fixture("none").headings.map((heading) => heading.number)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });
  it("renders rich heading content consistently in body, page metadata, manifest and search", async () => {
    const document = smallBook();
    const heading = headingBlock("unused");
    heading.source_number = "4.4.4";
    heading.content = [
      { type: "strong", content: [{ type: "text", text: "Virtual memory" }] },
      { type: "text", text: " " },
      { type: "math", latex: "x^2" },
    ];
    document.blocks[0] = heading;
    document.publishing.boundaries.body_start_block_id = heading.id;
    document.publishing.numbering = "generated";
    const book = compileBook(document),
      page = required(book.pages[0]);
    const rendered = await renderSemanticDocument({
      document: documentForPage(book, page),
      blockLinkIndex: book.blockLinkIndex,
      headingPresentations: book.headingByBlockId,
      publishedResourceUrl: () => {
        throw new Error("Unexpected resource");
      },
      resourceResolution: { diagnostics: [], references: [], resources: [] },
    });
    expect(book.headings[0]).toMatchObject({
      label: "1 Virtual memory x^2",
      number: "1",
      sourceNumber: "4.4.4",
    });
    expect(pageMetadata(book, page).title).toBe("1 Virtual memory x^2");
    expect(rendered.html).toContain("<strong>Virtual memory</strong>");
    expect(rendered.html).toContain('class="katex"');
    expect(rendered.html).not.toContain("4.4.4");
    expect(manifestFor(book).toc).toEqual([
      expect.objectContaining({
        block_id: heading.id,
        number: "1",
        title: "Virtual memory x^2",
      }),
    ]);
    const search = buildSearchSpool({
      authors: [],
      book,
      bookId: 1,
      title: "Book",
      versionId,
    });
    expect(
      search.shortRows.find((row) => row.kind === "heading")?.normalizedText,
    ).toBe("1 Virtual memory x^2");
  });
  it("builds a closed manifest from the same timestamp and visible navigation", () => {
    const manifest = manifestFor(fixture());
    expect(manifest).toMatchObject({
      schema_version: 5,
      book_id: 1,
      source_updated_at: 1000,
      version_id: versionId,
    });
    expect(manifest.toc).toHaveLength(4);
    expect(
      (
        manifest.toc as {
          number: string | null;
        }[]
      ).map((heading) => heading.number),
    ).toEqual([null, "1", null, null]);
  });
});
