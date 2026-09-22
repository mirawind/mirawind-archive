import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { e2eFixtureRoot } from "../helpers/global-setup";
import { loginAsAdministrator } from "../helpers/e2e-login";
import type { DraftView } from "@/web/contracts/publishing";

async function openBook(page: Page, address: string) {
  await loginAsAdministrator(page, address);
  await page
    .getByLabel("MinerU ZIP")
    .setInputFiles(resolve(e2eFixtureRoot, "publish.zip"));
  await page.getByRole("button", { name: "上传并分析", exact: true }).click();
  await expect(page.getByRole("link", { name: "打开出版工作台" })).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole("link", { name: "打开出版工作台" }).click();
  await expect(page.locator("iframe")).toBeVisible();
  const bookId = Number(new URL(page.url()).pathname.split("/").at(-1));
  if (!Number.isSafeInteger(bookId) || bookId < 1)
    throw new Error("BOOK_ID_INVALID");
  return bookId;
}
async function draft(page: Page, bookId: number) {
  return (await (
    await page.request.get(`/api/manage/books/${bookId}/draft`)
  ).json()) as DraftView;
}
async function ready(page: Page, bookId: number, after: number) {
  await expect
    .poll(
      async () => {
        const value = await draft(page, bookId);
        return {
          newer: value.updated_at > after,
          state: value.build?.state,
        };
      },
      { timeout: 45000 },
    )
    .toEqual({ newer: true, state: "ready" });
  return draft(page, bookId);
}

test("uses one heading policy through save, preview, private publication and mobile editing", async ({
  page,
  context,
}) => {
  const bookId = await openBook(page, "192.0.2.81");
  const preview = page.frameLocator("iframe");
  await preview.locator("a[rel='next']").click();
  await expect(preview.locator("[data-reader-page-id]")).toHaveAttribute(
    "data-reader-page-id",
    "2",
  );
  await preview.locator("a[rel='prev']").click();
  await expect(preview.locator("[data-reader-page-id]")).toHaveAttribute(
    "data-reader-page-id",
    "1",
  );
  const initial = await draft(page, bookId);
  const main = initial.structure.find((node) => node.title_markdown === "Main");
  if (!main) throw new Error("MAIN_HEADING_MISSING");
  await page.getByRole("button", { name: "Main", exact: true }).click();
  await page.getByRole("button", { name: "自动编号", exact: true }).click();
  await page.getByLabel("本节及子节不编号", { exact: true }).first().check();
  await page.getByLabel("标题", { exact: true }).first().fill("Main *edited*");
  await page
    .getByRole("button", { name: "保存并更新预览", exact: true })
    .click();
  const saved = await ready(page, bookId, initial.updated_at);
  const excluded = saved.preview?.headings.filter((node) =>
    ["Main edited", "Details", "Semantics"].includes(node.title),
  );
  expect(excluded).toHaveLength(3);
  for (const heading of excluded ?? [])
    expect((heading as { number?: string | null }).number).toBeNull();
  expect(
    saved.structure.find((node) => node.block_id === main.block_id)
      ?.exclude_from_numbering,
  ).toBe(true);
  await expect(
    page.frameLocator("iframe").locator(`[data-block-id="${main.block_id}"]`),
  ).toContainText("Main edited");
  await expect(
    page.getByRole("button", { name: "发布当前预览", exact: true }),
  ).toBeEnabled({ timeout: 15000 });
  await page.getByRole("button", { name: "发布当前预览", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已发布", exact: true }),
  ).toBeVisible();
  await test.info().attach("workbench-desktop", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  const reader = await context.newPage();
  await reader.goto(`/read/${bookId}`);
  expect((await reader.request.get(`/read/${bookId}`)).status()).toBe(200);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "结构", exact: true }).click();
  await page.getByRole("button", { name: "当前项", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await test.info().attach("workbench-mobile", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("retains paragraph typing while saving and preserves block identity", async ({
  page,
}) => {
  const bookId = await openBook(page, "192.0.2.82");
  const initial = await draft(page, bookId);
  const paragraph = page
    .frameLocator("iframe")
    .locator("p[data-block-id]")
    .first();
  const blockId = await paragraph.getAttribute("data-block-id");
  if (!blockId) throw new Error("PARAGRAPH_MISSING");
  await paragraph.click();
  const dialog = page.getByRole("dialog");
  const text = dialog.locator("textarea");
  await expect(text).toBeVisible();
  await text.fill("Submitted paragraph.");
  let release!: () => void, applied!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const committed = new Promise<void>((resolve) => {
    applied = resolve;
  });
  let hold = true;
  await page.route(
    "**/api/manage/books/" + bookId + "/draft",
    async (route) => {
      const response = await route.fetch();
      if (hold && route.request().method() === "PATCH") {
        applied();
        await gate;
      }
      await route.fulfill({ response });
    },
  );
  const saving = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith("/draft"),
  );
  await dialog
    .getByRole("button", { name: "保存正文并更新预览", exact: true })
    .click();
  await committed;
  await text.fill("Typed after submission.");
  hold = false;
  release();
  expect((await saving).status()).toBe(200);
  await expect(text).toHaveValue("Typed after submission.");
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(
              "/api/manage/books/" + bookId + "/draft/blocks/" + blockId,
            )
          ).json()
        ).markdown,
    )
    .toBe("Typed after submission.");
  await dialog
    .getByRole("button", { name: "关闭正文编辑", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await ready(page, bookId, initial.updated_at);
  const block = await (
    await page.request.get(
      `/api/manage/books/${bookId}/draft/blocks/${blockId}`,
    )
  ).json();
  expect(block).toMatchObject({
    block_id: blockId,
    kind: "paragraph",
    markdown: "Typed after submission.",
  });
});

test("rejects a second editor's stale save without discarding local changes", async ({
  page,
  context,
}) => {
  const bookId = await openBook(page, "192.0.2.83");
  const initial = await draft(page, bookId);
  const other = await context.newPage();
  await other.goto(`/manage/books/${bookId}`);
  const otherTitle = other.getByLabel("标题", { exact: true }).first();
  await expect(otherTitle).toBeVisible();
  await page
    .getByLabel("标题", { exact: true })
    .first()
    .fill("First editor accepted title");
  await page
    .getByRole("button", { name: "保存并更新预览", exact: true })
    .click();
  await ready(page, bookId, initial.updated_at);
  const stale = other.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith("/draft"),
  );
  await otherTitle.fill("Second editor local title");
  expect((await stale).status()).toBe(412);
  await expect(otherTitle).toHaveValue("Second editor local title");
  await expect(
    other.getByRole("button", { name: "放弃本地修改并重新载入", exact: true }),
  ).toBeVisible();
  expect((await draft(page, bookId)).structure[0]?.title_markdown).toBe(
    "First editor accepted title",
  );
});
