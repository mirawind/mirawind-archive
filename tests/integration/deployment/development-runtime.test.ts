import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";

import { expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";

import {
  mineruZip,
  mineruTitle,
  mineruParagraph,
} from "../../helpers/mineru-v2";
import { createTemporaryDataRoot } from "../../helpers/data-root";
import {
  reserveTcpPort,
  startManagedTestProcess,
} from "../../helpers/processes";

it("owns local Web and worker through upload, restart and process failures", async () => {
  const root = await createTemporaryDataRoot("development-runtime");
  const port = await reserveTcpPort();
  const origin = `http://127.0.0.1:${port}`;
  const start = () =>
    startManagedTestProcess(
      process.execPath,
      ["--env-file-if-exists=.env", "--import", "tsx", "scripts/dev.mjs"],
      {
        env: {
          ...process.env,
          VITEST: "",
          NODE_ENV: "development",
          MIRAWIND_LOCAL_DEVELOPMENT_TRUST: "1",
          MIRAWIND_DATA_DIR: root.path,
          MIRAWIND_PUBLIC_ORIGIN: origin,
          MIRAWIND_ALLOWED_HOSTS: "127.0.0.1,localhost",
          MIRAWIND_PASSKEY_RP_ID: "127.0.0.1",
          MIRAWIND_AUTH_SECRET: "test-only-secret-0123456789-abcdef",
          CODEX_CI: "1",
        },
      },
    );
  let runtime = start();
  let browser: Browser | undefined;
  const readWorkerPid = async () =>
    Number(await readFile(resolve(root.path, "tmp/worker.pid"), "utf8"));
  const exited = async () =>
    expect
      .poll(
        () =>
          runtime.child.exitCode !== null || runtime.child.signalCode !== null,
        { timeout: 20_000 },
      )
      .toBe(true);
  try {
    await runtime.waitForOutput(/Mirawind development ready:/, 30_000);
    const security = await fetch(`${origin}/manage/security`);
    const securityHtml = await security.text();
    expect(
      security.status,
      `${security.url}\n${securityHtml.slice(-1000)}\n${runtime.output()}`,
    ).toBe(200);
    expect(security.headers.get("cache-control")).toBe("private, no-store");

    const alias = `http://localhost:${port}`;
    const redirected = await fetch(`${alias}/library`, {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    expect(redirected.status).toBe(303);
    expect(redirected.headers.get("location")).toBe(`${origin}/library`);
    for (const [requestOrigin, code] of [
      [alias, 403],
      [origin, 400],
    ] as const) {
      const invalid = await fetch(`${origin}/api/manage/books/0`, {
        method: "DELETE",
        headers: { Origin: requestOrigin, "Content-Type": "application/json" },
        body: "{}",
      });
      expect(invalid.status).toBe(code);
    }

    const duplicate = start();
    try {
      await duplicate.waitForOutput(
        /A worker is already using this data directory/,
      );
      expect((await fetch(`${origin}/manage`)).status).toBe(200);
    } finally {
      await duplicate.stop();
    }

    browser = await chromium.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(15_000);
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.goto(`${alias}/manage`);
    expect(page.url()).toBe(`${origin}/manage`);
    await page.locator("astro-island[ssr]").waitFor({ state: "detached" });
    await page.getByLabel("MinerU ZIP", { exact: true }).setInputFiles({
      name: "development-runtime.zip",
      mimeType: "application/zip",
      buffer: mineruZip([
        [mineruTitle("Local Runtime Book"), mineruParagraph("Body.")],
      ]),
    });
    await page.getByText("development-runtime.zip", { exact: true }).waitFor();
    const uploadedPromise = page.waitForResponse(
      (response) =>
        response.url() === `${origin}/api/manage/imports` &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "上传并分析", exact: true }).click();
    const uploaded = await uploadedPromise;
    expect(uploaded.status()).toBe(202);
    const { import_id: importId } = (await uploaded.json()) as {
      import_id: string;
    };
    await expect
      .poll(
        async () => {
          const result = await fetch(
            `${origin}/api/manage/imports/${importId}`,
          );
          return result.json();
        },
        { timeout: 20_000 },
      )
      .toMatchObject({ state: "draft_ready", preview: { state: "ready" } });
    await page.getByRole("link", { name: "打开出版工作台" }).waitFor();
    await page.getByRole("link", { name: "安全", exact: true }).click();
    await page.waitForURL(`${origin}/manage/security`);
    expect(browserErrors).toEqual([]);

    runtime.child.kill("SIGTERM");
    await exited();
    expect(runtime.child.exitCode).toBe(0);
    await expect(
      readFile(resolve(root.path, "tmp/worker.pid")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fetch(`${origin}/manage`)).rejects.toThrow();

    runtime = start();
    await runtime.waitForOutput(/Mirawind development ready:/, 30_000);
    expect(
      (
        await fetch(`${origin}/api/manage/imports/${importId}`).then(
          (response) => response.json(),
        )
      ).state,
    ).toBe("draft_ready");

    const library = (await fetch(`${origin}/api/manage/library`).then(
      (response) => response.json(),
    )) as {
      entries: { book_id: number; title: string }[];
    };
    const book = library.entries.at(0);
    if (!book) throw new Error("Imported book is missing from the library");
    const draftResponse = await fetch(
      `${origin}/api/manage/books/${book.book_id}/draft`,
    );
    const draft = (await draftResponse.json()) as {
      updated_at: number;
      build: { id: string };
    };
    const published = await fetch(
      `${origin}/api/manage/books/${book.book_id}/publish`,
      {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expected_updated_at: draft.updated_at,
          build_id: draft.build.id,
        }),
      },
    );
    expect(published.ok).toBe(true);
    await page.goto(`${alias}/library`);
    await page
      .getByRole("button", { name: `永久删除《${book.title}》`, exact: true })
      .click();
    const deletionDialog = page.getByRole("dialog");
    expect(
      await deletionDialog
        .getByRole("button", { name: "永久删除", exact: true })
        .isEnabled(),
    ).toBe(false);
    await deletionDialog.getByLabel("输入完整书名以确认").fill(book.title);
    const deletionResponse = page.waitForResponse(
      (response) => response.request().method() === "DELETE",
    );
    await deletionDialog
      .getByRole("button", { name: "永久删除", exact: true })
      .click();
    const deletion = await deletionResponse;
    expect(deletion.status()).toBe(202);
    const { jobId: cleanupId } = (await deletion.json()) as { jobId: string };
    await expect
      .poll(
        async () =>
          (
            await fetch(`${origin}/api/manage/jobs/${cleanupId}`).then(
              (response) => response.json(),
            )
          ).state,
        { timeout: 15_000 },
      )
      .toBe("succeeded");
    await expect(
      stat(resolve(root.path, "books", String(book.book_id))),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await fetch(`${origin}/api/manage/books/${book.book_id}/draft`)).status,
    ).toBe(404);
    await deletionDialog.waitFor({ state: "detached" });

    process.kill(await readWorkerPid(), "SIGTERM");
    await exited();
    expect(runtime.child.exitCode).toBe(1);
    await expect(fetch(`${origin}/manage`)).rejects.toThrow();

    runtime = start();
    await runtime.waitForOutput(/Mirawind development ready:/, 30_000);
    const orphanPid = await readWorkerPid();
    runtime.child.kill("SIGKILL");
    await exited();
    await expect
      .poll(
        () => {
          try {
            process.kill(orphanPid, 0);
            return false;
          } catch {
            return true;
          }
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    await expect(
      readFile(resolve(root.path, "tmp/worker.pid")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await browser.close();
    browser = undefined;
    const occupied = createServer();
    await new Promise<void>((resolveListen) =>
      occupied.listen(port, "127.0.0.1", resolveListen),
    );
    try {
      runtime = start();
      await exited();
      expect(runtime.child.exitCode).toBe(1);
      expect(runtime.output()).not.toContain("Mirawind development ready:");
      await expect(
        readFile(resolve(root.path, "tmp/worker.pid")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        occupied.close((error) =>
          error ? rejectClose(error) : resolveClose(),
        ),
      );
    }
  } finally {
    await browser?.close();
    await runtime.stop();
    await root.cleanup();
  }
}, 100_000);
