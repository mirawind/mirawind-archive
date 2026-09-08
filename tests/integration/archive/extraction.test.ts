import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractZipFile } from "@/modules/publishing/adapters/filesystem/extract-archive";
import { buildZip } from "../../../scripts/fixtures/zip-builder";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function fixture(bytes: Buffer) {
  const root = await mkdtemp(join(tmpdir(), "archive-extraction-"));
  roots.push(root);
  const archivePath = join(root, "input.zip");
  await writeFile(archivePath, bytes);
  return { archivePath, destination: join(root, "extracted") };
}

describe("archive extraction", () => {
  it("extracts stored and compressed content with directories and byte counts", async () => {
    const input = await fixture(
      buildZip({
        entries: [
          { name: "book/" },
          { name: "book/content_list_v2.json", data: "[]", method: 8 },
          { name: "book/images/a.bin", data: "image" },
        ],
      }),
    );
    expect(await extractZipFile(input)).toMatchObject({
      entries: 3,
      files: 2,
      totalUncompressedBytes: 7,
    });
    expect(
      await readFile(
        join(input.destination, "book/content_list_v2.json"),
        "utf8",
      ),
    ).toBe("[]");
    expect(
      await readFile(join(input.destination, "book/images/a.bin"), "utf8"),
    ).toBe("image");
  });

  it("cleans incomplete extraction when the ZIP cannot be read", async () => {
    const input = await fixture(Buffer.from("incomplete download"));
    await expect(extractZipFile(input)).rejects.toMatchObject({
      code: "ARCHIVE_MALFORMED",
    });
    await expect(access(input.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("honors cancellation before creating output", async () => {
    const input = await fixture(
      buildZip({
        entries: [{ name: "book/content_list_v2.json", data: "[]" }],
      }),
    );
    await expect(
      extractZipFile({ ...input, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "ARCHIVE_CANCELED" });
    await expect(access(input.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
