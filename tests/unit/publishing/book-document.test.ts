import { describe, expect, it } from "vitest";

import {
  validateBookDocument,
  nextContentTimestamp,
} from "../../../src/modules/publishing/core/content/book-document";
import { presentBookHeadings } from "../../../src/modules/publishing/core/content/heading-presentation";
import type {
  BookDocument,
  HeadingBlock,
} from "../../../src/modules/publishing/core/content/book-document.generated";

const id = (letter: string) => `blk_${letter.repeat(24)}`;
function heading(
  letter: string,
  level: number,
  excluded = false,
): HeadingBlock {
  return {
    id: id(letter),
    type: "heading",
    level,
    content: [{ type: "text", text: letter }],
    source_number: letter,
    include_in_toc: true,
    starts_page: level === 1,
    exclude_from_numbering: excluded,
  };
}
function book(): BookDocument {
  return {
    schema_version: 1,
    book_id: 1,
    updated_at: 1000,
    metadata: { title: "Book" },
    publishing: {
      numbering: "generated",
      code: { line_numbers: false },
      boundaries: { body_start_block_id: id("a") },
    },
    resources: [],
    blocks: [
      heading("a", 1),
      heading("b", 2, true),
      heading("c", 3),
      heading("d", 2),
      heading("e", 1),
    ],
  };
}

describe("editable book content", () => {
  it("rejects unknown fields, duplicate identities, invalid references and heading jumps", () => {
    expect(validateBookDocument(book()).book_id).toBe(1);
    expect(() => validateBookDocument({ ...book(), revision: 1 })).toThrow();
    expect(() =>
      validateBookDocument({ ...book(), schema_version: 2 }),
    ).toThrow();
    expect(() =>
      validateBookDocument({
        ...book(),
        blocks: [heading("a", 1), heading("a", 2)],
      }),
    ).toThrow();
    expect(() =>
      validateBookDocument({
        ...book(),
        blocks: [heading("a", 1), heading("b", 3)],
      }),
    ).toThrow();
    expect(() =>
      validateBookDocument({
        ...book(),
        metadata: { title: "Book", cover_resource_id: `res_${"a".repeat(24)}` },
      }),
    ).toThrow();
  });

  it("rejects cyclic and deeply nested input before schema recursion", () => {
    const value: Record<string, unknown> = {};
    value.loop = value;
    expect(() => validateBookDocument(value)).toThrow();
    let nested: unknown = "text";
    for (let index = 0; index < 150; index++) nested = { content: [nested] };
    expect(() => validateBookDocument(nested)).toThrow();
  });

  it("keeps a timestamp strictly increasing in the same millisecond and after clock rollback", () => {
    expect(nextContentTimestamp(1000, 2000)).toBe(2000);
    expect(nextContentTimestamp(1000, 1000)).toBe(1001);
    expect(nextContentTimestamp(1000, 900)).toBe(1001);
    expect(() => nextContentTimestamp(8640000000000000, 1)).toThrow();
    expect(() => nextContentTimestamp(1000, Number.NaN)).toThrow();
  });
});

describe("one heading policy", () => {
  it("excludes the complete subtree from numbering and resumes without consuming a number", () => {
    expect(presentBookHeadings(book()).map((value) => value.number)).toEqual([
      "1",
      null,
      null,
      "1.1",
      "2",
    ]);
  });

  it("suppresses source labels without deleting them and restores them when the parent is included", () => {
    const document = book();
    document.publishing.numbering = "source";
    expect(presentBookHeadings(document).map((value) => value.number)).toEqual([
      "a",
      null,
      null,
      "d",
      "e",
    ]);
    const parent = document.blocks[1] as HeadingBlock;
    parent.exclude_from_numbering = false;
    expect(presentBookHeadings(document).map((value) => value.number)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    document.publishing.numbering = "none";
    expect(presentBookHeadings(document).map((value) => value.number)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(parent.source_number).toBe("b");
  });

  it("keeps TOC visibility independent of numbering and only generates body numbers", () => {
    const document = book();
    (document.blocks[3] as HeadingBlock).include_in_toc = false;
    document.publishing.boundaries.backmatter_start_block_id = id("e");
    expect(presentBookHeadings(document).map((value) => value.number)).toEqual([
      "1",
      null,
      null,
      "1.1",
      null,
    ]);
  });
});
