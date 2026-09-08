import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { removeExactContainedTree } from "@/platform/filesystem/permanent-removal";

const cacheRoot = resolve(".cache");
const e2eDirectories = [
  resolve(cacheRoot, "e2e-ir-fixtures"),
  resolve(cacheRoot, "e2e-playwright-ir-data"),
] as const;

async function removeE2eDirectory(path: string): Promise<void> {
  if (dirname(path) !== cacheRoot) {
    throw new Error("Refusing to clean a non-E2E data root");
  }
  const pid = Number(
    await readFile(resolve(path, "tmp/worker.pid"), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      },
    ),
  );
  if (Number.isSafeInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      throw new Error("Stop the E2E worker before deleting its data root.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  await removeExactContainedTree({ root: cacheRoot, target: path });
}

await Promise.all(e2eDirectories.map(removeE2eDirectory));
