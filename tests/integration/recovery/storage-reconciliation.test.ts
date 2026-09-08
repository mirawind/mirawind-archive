import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  reconcilePublishingStorage,
  publishingOrphanGraceMs,
} from "@/modules/publishing/adapters/filesystem/storage-reconciliation";
import { DocumentRepository } from "@/modules/publishing/adapters/sqlite/documents";
import { JobRepository } from "@/modules/publishing/adapters/sqlite/jobs";
import { withMigratedTestDatabase } from "../../helpers/database";
import { installIrDraft } from "../../helpers/ir-book";

async function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
}
async function write(path: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "contents");
}
describe("block storage reconciliation", () => {
  it("keeps the database draft, registered originals and active work while removing unregistered files", () =>
    withMigratedTestDatabase(async ({ database }, { layout }) => {
      const fixture = await installIrDraft(database, layout);
      const documents = new DocumentRepository(database);
      const before = documents.read(fixture.book.book_id);
      const jobs = new JobRepository(database),
        now = Date.now();
      const active = jobs.claimNext({ leaseOwner: "test", nowMs: now });
      if (!active) throw new Error("JOB_MISSING");
      const working = resolve(
        layout.root,
        "staging",
        active.id,
        "input/book.json",
      );
      const abandoned = resolve(layout.root, "staging/abandoned/input");
      const orphan = resolve(
        layout.bookDirectory,
        String(before.book_id),
        "assets/res_unregistered_000001.png",
      );
      await write(working);
      await write(abandoned);
      await write(orphan);
      const original = database
        .prepare("SELECT storage_rel_path FROM original_files WHERE book_id=?")
        .get(before.book_id) as { storage_rel_path: string };
      const originalBytes = await readFile(
        resolve(layout.root, original.storage_rel_path),
      );
      const future = now + publishingOrphanGraceMs + 1000;
      jobs.heartbeat({ jobId: active.id, leaseOwner: "test", nowMs: future });
      await reconcilePublishingStorage({ database, layout, nowMs: future });
      expect(await exists(working)).toBe(true);
      expect(await exists(abandoned)).toBe(false);
      expect(await exists(orphan)).toBe(false);
      expect(documents.read(before.book_id)).toEqual(before);
      expect(
        await readFile(resolve(layout.root, original.storage_rel_path)),
      ).toEqual(originalBytes);
    }));
});
