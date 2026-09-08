import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  rendererAssetBaseUrl,
  rendererStylesheetUrl,
} from "@/modules/publishing/core/publication/render-assets";

const execFileAsync = promisify(execFile);
const generatedRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    generatedRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("pinned renderer asset closure", () => {
  it("generates one local WOFF2-only KaTeX closure with license and integrity", async () => {
    const root = await mkdtemp(join(tmpdir(), "renderer-assets-"));
    generatedRoots.push(root);
    const output = resolve(root, "semantic-html-v8-katex-0.18.1");
    const repeatedOutput = resolve(
      root,
      "semantic-html-v8-katex-0.18.1-repeated",
    );
    await execFileAsync(process.execPath, [
      "scripts/prepare-renderer-assets.mjs",
      "--output",
      output,
    ]);
    await execFileAsync(process.execPath, [
      "scripts/prepare-renderer-assets.mjs",
      "--output",
      repeatedOutput,
    ]);

    const manifest = JSON.parse(
      await readFile(resolve(output, "integrity.json"), "utf8"),
    ) as {
      readonly files: readonly {
        readonly path: string;
        readonly sha256: string;
        readonly size: number;
      }[];
      readonly katex_version: string;
      readonly renderer_version: string;
    };
    const css = await readFile(resolve(output, "katex.css"), "utf8");

    expect(rendererAssetBaseUrl).toBe(
      "/reader-assets/renderers/semantic-html-v8-katex-0.18.1",
    );
    expect(rendererStylesheetUrl).toBe(`${rendererAssetBaseUrl}/katex.css`);
    expect(manifest).toMatchObject({
      katex_version: "0.18.1",
      renderer_version: "semantic-html-v8-katex-0.18.1",
    });
    expect(
      manifest.files.filter((file) => file.path.endsWith(".woff2")),
    ).toHaveLength(20);
    expect(manifest.files.map((file) => file.path)).toContain("LICENSE");
    expect(css).not.toMatch(/https?:|\.woff(?:["')]|$)|\.ttf/iu);
    expect(css).toMatch(/url\(fonts\/KaTeX_Main-Regular\.woff2\)/u);
    expect(await readFile(resolve(repeatedOutput, "katex.css"))).toEqual(
      await readFile(resolve(output, "katex.css")),
    );
    expect(await readFile(resolve(repeatedOutput, "integrity.json"))).toEqual(
      await readFile(resolve(output, "integrity.json")),
    );

    for (const file of manifest.files) {
      const bytes = await readFile(resolve(output, file.path));
      expect((await stat(resolve(output, file.path))).isFile()).toBe(true);
      expect(bytes.byteLength).toBe(file.size);
      expect(sha256(bytes)).toBe(file.sha256);
    }
  });
});
