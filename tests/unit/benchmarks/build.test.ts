import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseBuildArguments,
  resolveBenchmarkFixtures,
} from "../../../scripts/benchmarks/build.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function realFixture(id: string, value: string) {
  return {
    file_name: `${id}.zip`,
    id,
    mineru_version: "3.4.4",
    page_count_range: { maximum: 600, minimum: 200 },
    sha256: createHash("sha256").update(value).digest("hex"),
    size_bytes: Buffer.byteLength(value),
    usage_scope: {
      designated_by: "administrator",
      local_compatibility_testing: true,
      local_performance_testing: true,
      public_ci: false,
      redistribution: false,
      repository_storage: false,
    },
  } as const;
}

describe("build benchmark arguments", () => {
  it("selects fixtures, repetitions and profiling without synthetic stress", () => {
    const parsed = parseBuildArguments([
      "--real-dir",
      "/tmp/real-fixtures",
      "--profile-dir",
      "/tmp/profiles",
      "--output",
      "/tmp/results.json",
      "--fixture-ids",
      "real-mineru-abcdef123456,real-mineru-fedcba654321",
      "--repetitions",
      "3",
      "--include-stress",
      "false",
    ]);
    expect(parsed).toMatchObject({
      fixtureIds: ["real-mineru-abcdef123456", "real-mineru-fedcba654321"],
      includeStress: false,
      repetitions: 3,
    });
  });

  it("keeps the established build benchmark defaults", () => {
    const parsed = parseBuildArguments([]);
    expect(parsed.includeStress).toBe(true);
    expect(parsed.repetitions).toBe(1);
  });

  it("resolves a selected profile without hashing unselected archives", async () => {
    const root = await mkdtemp(join(tmpdir(), "pipeline-profile-fixtures-"));
    roots.push(root);
    const temporaryDirectory = join(root, "temporary");
    const first = realFixture("real-mineru-a7f31c", "selected");
    const second = realFixture("real-mineru-b9d204", "expected-unselected");
    await Promise.all([
      writeFile(join(root, first.file_name), "selected"),
      writeFile(join(root, second.file_name), "altered-unselected"),
      writeFile(
        join(root, "real-fixtures.json"),
        JSON.stringify({ fixtures: [first, second], schema_version: 1 }),
      ),
    ]);

    await expect(
      resolveBenchmarkFixtures(
        {
          fixtureIds: [first.id],
          includeStress: false,
          output: null,
          realDirectory: root,
          realManifest: null,
          retainDirectory: null,
          stress: { blocksPerPage: 1, imageCount: 0, pages: 1 },
        },
        temporaryDirectory,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        id: first.id,
        path: join(root, first.file_name),
      }),
    ]);
  });

  it("rejects duplicate fixture IDs", () => {
    expect(() =>
      parseBuildArguments([
        "--fixture-ids",
        "real-mineru-abcdef123456,real-mineru-abcdef123456",
      ]),
    ).toThrow("fixture IDs");
  });
});
