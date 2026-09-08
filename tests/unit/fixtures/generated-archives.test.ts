import { BlobReader, ZipReader } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import { buildStressBook } from "../../../scripts/fixtures/build-stress-book";
import { buildZip, crc32 } from "../../../scripts/fixtures/zip-builder";

async function entryNames(bytes: Buffer): Promise<readonly string[]> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const reader = new ZipReader(new BlobReader(new Blob([copy])));
  try {
    return (await reader.getEntries()).map((entry) => entry.filename);
  } finally {
    await reader.close();
  }
}

describe("deterministic generated archives", () => {
  it("builds a standards-readable ZIP with stable bytes and CRC", async () => {
    const input = Buffer.from("deterministic");
    const first = buildZip({
      entries: [{ data: input, method: 8, name: "book/full.md" }],
    });
    const second = buildZip({
      entries: [{ data: input, method: 8, name: "book/full.md" }],
    });

    expect(first).toEqual(second);
    expect(crc32(input)).toBe(0x6f4500fc);
    expect(await entryNames(first)).toEqual(["book/full.md"]);
  });

  it("builds a repeatable bounded several-hundred-page stress book", async () => {
    const options = { blocksPerPage: 3, imageCount: 4, pages: 300 };
    const first = buildStressBook(options);
    const second = buildStressBook(options);

    expect(first.metadata).toEqual(second.metadata);
    expect(first.bytes).toEqual(second.bytes);
    expect(first.metadata.pages).toBe(300);
    expect(await entryNames(first.bytes)).toEqual(
      expect.arrayContaining([
        "stress-result/content_list_v2.json",
        "stress-result/images/image-003.png",
      ]),
    );
    expect(() =>
      buildStressBook({ blocksPerPage: 1, imageCount: 0, pages: 2_001 }),
    ).toThrow(/pages/);
  });
});
