import { resolve } from "node:path";

import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import Database from "better-sqlite3";

import {
  e2eDataRoot,
  e2eFixtureRoot,
  e2eOrigin,
} from "../helpers/global-setup.js";
import {
  expectNoPageOverflow,
  expectNoSeriousAccessibilityFindings,
} from "../helpers/accessibility.js";
import { loginAsAdministrator } from "../helpers/e2e-login.js";

async function expectFormulaPresentation(document: Page | FrameLocator) {
  const formula = document.locator(".katex").first();
  const mathml = formula.locator(".katex-mathml");
  const visual = formula.locator(".katex-html");

  await expect(formula).toBeVisible();
  await expect(mathml.locator("math")).toHaveCount(1);
  await expect(mathml).not.toHaveAttribute("aria-hidden", "true");
  await expect(visual).toHaveAttribute("aria-hidden", "true");
  await expect(visual).toBeVisible();
}

function expectRendererClosure(
  responses: readonly { status: number; url: string }[],
  failures: readonly { error: string; url: string }[],
) {
  expect(failures).toEqual([]);
  expect(responses).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        status: 200,
        url: expect.stringContaining(
          "/reader-assets/renderers/semantic-html-v8-katex-0.18.1/katex.css",
        ),
      }),
      expect.objectContaining({
        status: 200,
        url: expect.stringMatching(/\.woff2$/u),
      }),
    ]),
  );
  expect(responses.every((response) => response.status < 400)).toBe(true);
}

test("closes typography, formula and printed contents preview-to-publication behavior", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const rendererResponses: { status: number; url: string }[] = [];
  const rendererFailures: { error: string; url: string }[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/reader-assets/renderers/")) {
      rendererResponses.push({
        status: response.status(),
        url: response.url(),
      });
    }
  });
  page.on("requestfailed", (request) => {
    if (request.url().includes("/reader-assets/renderers/")) {
      rendererFailures.push({
        error: request.failure()?.errorText ?? "unknown",
        url: request.url(),
      });
    }
  });

  await loginAsAdministrator(page, "192.0.2.13");

  await page
    .getByLabel("MinerU ZIP")
    .setInputFiles(resolve(e2eFixtureRoot, "publishing-quality.zip"));
  await page.getByRole("button", { name: "上传并分析" }).click();
  await expect(page.getByRole("link", { name: "打开出版工作台" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("link", { name: "打开出版工作台" }).click();

  await expect(page.locator("iframe")).toHaveAttribute(
    "sandbox",
    "allow-scripts",
  );
  const previewSource = await page.locator("iframe").getAttribute("src");
  expect(previewSource).toBeTruthy();
  const previewResponse = await page.request.get(previewSource ?? "");
  expect(previewResponse.status()).toBe(200);
  expect(previewResponse.headers()["cache-control"]).toBe("private, no-store");
  expect(previewResponse.headers()["x-robots-tag"]).toContain("noindex");
  expect(previewResponse.headers()["referrer-policy"]).toBe("no-referrer");
  expect(previewResponse.headers()["cross-origin-resource-policy"]).toBe(
    "cross-origin",
  );
  expect(previewResponse.headers()["content-security-policy"]).toContain(
    `frame-ancestors ${e2eOrigin}`,
  );

  const rendererStylesheet =
    "/reader-assets/renderers/semantic-html-v8-katex-0.18.1/katex.css";
  const rendererResponse = await page.request.get(rendererStylesheet);
  expect(rendererResponse.headers()["cache-control"]).toBe(
    "public, max-age=31536000, immutable",
  );
  expect(rendererResponse.headers()["access-control-allow-origin"]).toBe("*");
  expect(rendererResponse.headers()["cross-origin-resource-policy"]).toBe(
    "cross-origin",
  );
  const rendererPreflight = await page.request.fetch(rendererStylesheet, {
    headers: {
      "Access-Control-Request-Headers": "x-real-ip",
      "Access-Control-Request-Method": "GET",
      Origin: "null",
    },
    method: "OPTIONS",
  });
  expect(rendererPreflight.status()).toBe(204);
  expect(rendererPreflight.headers()["access-control-allow-origin"]).toBe("*");

  const preview = page.frameLocator("iframe");
  await expect(
    preview.getByText("中文 English123 测试，继续：结束？"),
  ).toBeVisible();
  await expect(preview.locator(".math-fallback code")).toContainText(
    "\\notacommand{",
  );
  await expect(preview.locator(".katex")).toHaveCount(1);
  await expectFormulaPresentation(preview);
  const previewFrame = page
    .frames()
    .find((frame) => frame.url().includes("/preview/"));
  expect(previewFrame).toBeTruthy();
  await previewFrame?.evaluate(async () => document.fonts.ready);
  expectRendererClosure(rendererResponses, rendererFailures);
  rendererResponses.length = 0;
  rendererFailures.length = 0;

  const katexStylesheet = "**/reader-assets/renderers/**/katex.css";
  await page.route(katexStylesheet, (route) => route.abort("blockedbyclient"));
  const previewIframe = page.locator("iframe");
  await previewIframe.evaluate((iframe: HTMLIFrameElement, source) => {
    iframe.src = `${String(source)}?blocked-katex=1`;
  }, previewSource);
  await expect(
    preview.getByText("中文 English123 测试，继续：结束？"),
  ).toBeVisible();
  await expect(preview.locator(".katex")).toHaveCount(1);
  await expectFormulaPresentation(preview);
  await page.unroute(katexStylesheet);
  rendererResponses.length = 0;
  rendererFailures.length = 0;

  const qualityBookId = Number(new URL(page.url()).pathname.split("/").at(-1));
  const storage = new Database(resolve(e2eDataRoot, "db/mirawind.sqlite"), {
    readonly: true,
  });
  let body: string;
  try {
    body = (
      storage
        .prepare(
          "SELECT content_json FROM book_blocks WHERE book_id=? ORDER BY ordinal",
        )
        .all(qualityBookId) as { content_json: string }[]
    )
      .map((row) => row.content_json)
      .join("\n");
  } finally {
    storage.close();
  }
  expect(body).toContain("中文 English123 测试，继续：结束？");
  expect(body).toContain("https://example.com/a?x=1&y=2");
  expect(body).toContain("v1.2.3");
  expect(body).toContain("x+y");

  await page.getByRole("button", { name: "发布当前预览" }).click();
  await expect(page.getByRole("link", { name: "开始阅读" })).toBeVisible({
    timeout: 60_000,
  });
  const readingHref = await page
    .getByRole("link", { name: "开始阅读" })
    .getAttribute("href");
  expect(readingHref).toBeTruthy();
  await page.goto(readingHref ?? "");
  await page.waitForLoadState("networkidle");
  await page.evaluate(async () => document.fonts.ready);

  await expect(
    page.getByText("中文 English123 测试，继续：结束？"),
  ).toBeVisible();
  await expect(page.locator(".math-fallback code")).toContainText(
    "\\notacommand{",
  );
  await expect(page.locator(".katex")).toHaveCount(1);
  await expectFormulaPresentation(page);

  expectRendererClosure(rendererResponses, rendererFailures);
  await page.goto("/manage");

  await page
    .getByLabel("MinerU ZIP")
    .setInputFiles(resolve(e2eFixtureRoot, "printed-toc.zip"));
  await page.getByRole("button", { name: "上传并分析" }).click();
  await expect(page.getByRole("link", { name: "打开出版工作台" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("link", { name: "打开出版工作台" }).click();

  const printedPreview = page.frameLocator("iframe");
  await expect(
    printedPreview.getByRole("heading", { name: "目录" }),
  ).toHaveCount(0);
  await expect(printedPreview.locator(".reader-document")).not.toContainText(
    "...... 1",
  );
  await expect(
    printedPreview.getByRole("heading", { name: "第 1 章 绪论" }),
  ).toBeVisible();

  await expect(printedPreview.locator(".reader-document")).not.toContainText(
    "...... 1",
  );

  const databasePath = resolve(e2eDataRoot, "db", "mirawind.sqlite");
  const book = { id: Number(new URL(page.url()).pathname.split("/").at(-1)) };
  const retained = new Database(databasePath, { readonly: true });
  try {
    const blocks = retained
      .prepare(
        "SELECT type,content_json FROM book_blocks WHERE book_id=? ORDER BY ordinal",
      )
      .all(book.id) as { type: string; content_json: string }[];
    expect(blocks.filter((block) => block.type === "heading")).toHaveLength(6);
    expect(blocks.map((block) => block.content_json).join("\n")).not.toContain(
      "......",
    );
  } finally {
    retained.close();
  }

  await page.getByRole("button", { name: "发布当前预览" }).click();
  await expect(page.getByRole("link", { name: "开始阅读" })).toBeVisible({
    timeout: 60_000,
  });
  const firstVersion = new Database(databasePath, { readonly: true });
  const firstVersionId = (() => {
    try {
      return (
        firstVersion
          .prepare("SELECT current_version_id FROM books WHERE id = ?")
          .get(book.id) as { current_version_id: string }
      ).current_version_id;
    } finally {
      firstVersion.close();
    }
  })();

  const printedReadingHref = await page
    .getByRole("link", { name: "开始阅读" })
    .getAttribute("href");
  await page.goto(printedReadingHref ?? "");
  await expect(page.locator(".reader-document")).not.toContainText("...... 1");
  await expect(
    page.getByRole("navigation", { name: "全书目录" }),
  ).toContainText("中文与 English 排版");

  await page.goBack();
  await page.reload();
  await expect(page.getByRole("button", { name: "已发布" })).toBeDisabled();
  await expect(page.getByRole("link", { name: "开始阅读" })).toBeVisible();
  const republished = new Database(databasePath, { readonly: true });
  try {
    const state = republished
      .prepare(
        `SELECT current_version_id,
                (SELECT COUNT(*) FROM book_versions WHERE book_id = books.id) AS version_count,
                (SELECT COUNT(*) FROM audit_events
                 WHERE book_id = books.id AND action = 'book.published') AS publish_count
         FROM books WHERE id = ?`,
      )
      .get(book.id) as {
      current_version_id: string;
      publish_count: number;
      version_count: number;
    };
    expect(state.current_version_id).toBe(firstVersionId);
    expect(state.version_count).toBe(1);
    expect(state.publish_count).toBe(1);
  } finally {
    republished.close();
  }
});

test("keeps the published reader accessible across the responsive and zoom matrix", async ({
  page,
}) => {
  for (const width of [320, 360, 768, 1_024, 1_440]) {
    await page.setViewportSize({ height: 900, width });
    await page.goto("/read/e2e-library-book/1");
    await expect(page.getByRole("main")).toContainText("A seeded public book");
    await expectNoPageOverflow(page);
  }

  await page.setViewportSize({ height: 900, width: 390 });
  await page.goto("/read/e2e-library-book/1");
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await expectNoPageOverflow(page);

  const chrome = await page.context().newCDPSession(page);
  await chrome.send("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 4,
    height: 225,
    mobile: false,
    width: 360,
  });
  await page.goto("/read/e2e-library-book/1");
  await expectNoPageOverflow(page);
  await chrome.send("Emulation.clearDeviceMetricsOverride");

  await page.setViewportSize({ height: 900, width: 1_024 });
  await page.goto("/read/e2e-library-book/1");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "跳到正文" })).toBeFocused();
  await expect(page.getByRole("link", { name: "跳到正文" })).toBeVisible();
  await expectNoSeriousAccessibilityFindings(page);
});
