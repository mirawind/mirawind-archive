import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { isSandboxedPreviewRead } from "../../../scripts/dev-preview-requests";

describe("development preview fetch metadata", () => {
  const asset =
    "/api/manage/books/1/preview/ver_0123456789abcdef/assets/res_0123456789abcdef";
  const request = (url: string, method = "GET") =>
    ({
      url,
      method,
      headers: { "sec-fetch-site": "cross-site" },
    }) as IncomingMessage;
  it("permits only the read-only CORS surfaces to reach their route guards", () => {
    expect(
      isSandboxedPreviewRead(request("/reader-assets/styles/reader.css")),
    ).toBe(true);
    expect(
      isSandboxedPreviewRead(request(asset + "?authorization=signed")),
    ).toBe(true);
    expect(
      isSandboxedPreviewRead(request(asset + "?authorization=signed", "HEAD")),
    ).toBe(true);
    for (const path of [
      asset,
      "/api/manage/books/1/draft",
      "/manage",
      "/_astro/source.js",
      "/reader-assets/../api/manage/books/1/draft",
    ])
      expect(isSandboxedPreviewRead(request(path))).toBe(false);
    for (const method of ["POST", "PATCH", "PUT", "DELETE", "OPTIONS"])
      expect(
        isSandboxedPreviewRead(
          request(asset + "?authorization=signed", method),
        ),
      ).toBe(false);
  });
});
