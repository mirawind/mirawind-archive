import Database from "better-sqlite3";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { e2eDataRoot, e2eFixtureRoot } from "../helpers/global-setup";
import { loginAsAdministrator } from "../helpers/e2e-login";

test("imports MinerU v2 into one editable book and rejects missing or multiple books", async ({
  page,
}) => {
  await loginAsAdministrator(page, "192.0.2.12");
  const upload = async (filename: string) => {
    await page.goto("/manage");
    await page
      .getByLabel("MinerU ZIP")
      .setInputFiles(resolve(e2eFixtureRoot, filename));
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/manage/imports") &&
        r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "上传并分析", exact: true }).click();
    const accepted = await response;
    expect(accepted.status()).toBe(202);
    return (await accepted.json()) as { import_id: string };
  };
  const accepted = await upload("high-confidence.zip");
  await expect(page.getByRole("link", { name: "打开出版工作台" })).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole("link", { name: "打开出版工作台" }).click();
  await expect(
    page.frameLocator("iframe").getByText("A durable source paragraph."),
  ).toBeVisible();
  const imported = (await (
    await page.request.get(`/api/manage/imports/${accepted.import_id}`)
  ).json()) as { book_id: number };
  const storage = new Database(resolve(e2eDataRoot, "db/mirawind.sqlite"), {
    readonly: true,
  });
  try {
    expect(
      storage
        .prepare(
          "SELECT book_id,schema_version,updated_at,json_extract(metadata_json,'$.title') AS title FROM book_documents WHERE book_id=?",
        )
        .get(imported.book_id),
    ).toMatchObject({
      book_id: imported.book_id,
      schema_version: 1,
      updated_at: expect.any(Number),
      title: "E2E Cloud Book",
    });
    expect(
      (
        storage
          .prepare(
            "SELECT count(*) AS count FROM book_blocks WHERE book_id=? AND type='paragraph'",
          )
          .get(imported.book_id) as { count: number }
      ).count,
    ).toBeGreaterThan(0);
  } finally {
    storage.close();
  }
  for (const [filename, error] of [
    ["generic.zip", "IMPORT_MINERU_JSON_MISSING"],
    ["ambiguous.zip", "IMPORT_MULTIPLE_BOOKS"],
  ]) {
    if (!filename || !error) throw new Error("Fixture missing");
    const rejected = await upload(filename);
    await expect
      .poll(
        async () =>
          await (
            await page.request.get(`/api/manage/imports/${rejected.import_id}`)
          ).json(),
        { timeout: 30000 },
      )
      .toMatchObject({ state: "rejected", error_code: error });
  }
});
