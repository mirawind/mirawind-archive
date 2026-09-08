import { describe, expect, it } from "vitest";

import { readerMermaidScriptUrl } from "@/modules/reader/application/reader-api";

import {
  GET,
  HEAD,
  OPTIONS,
} from "../../../src/pages/reader-assets/[...assetPath].js";

const stylesheet = "renderers/semantic-html-v8-katex-0.18.1/katex.css";

describe("versioned reader asset responses", () => {
  it("serves current assets with immutable cross-origin GET and HEAD policy", async () => {
    const get = await GET({
      params: { assetPath: stylesheet },
    } as never);
    const head = await HEAD({
      params: { assetPath: stylesheet },
    } as never);

    for (const response of [get, head]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("cross-origin-resource-policy")).toBe(
        "cross-origin",
      );
      expect(response.headers.get("content-type")).toBe(
        "text/css; charset=utf-8",
      );
    }
    expect(await get.text()).toContain(".katex");
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe(
      get.headers.get("content-length"),
    );
  });

  it("answers opaque-origin preflight and rejects superseded identities", async () => {
    const preflight = await OPTIONS({
      params: { assetPath: stylesheet },
    } as never);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-methods")).toContain(
      "GET",
    );

    await expect(
      GET({
        params: {
          assetPath: "renderers/semantic-html-v3-katex-0.18.1/katex.css",
        },
      } as never),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("serves the pinned Mermaid entry but not arbitrary files", async () => {
    const assetPath = readerMermaidScriptUrl.replace("/reader-assets/", "");
    const response = await GET({ params: { assetPath } } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await response.text()).toContain("renderMermaidDiagrams");
    await expect(
      GET({
        params: {
          assetPath: "scripts/mirawind-mermaid-11.16.0/package.json",
        },
      } as never),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });
});
