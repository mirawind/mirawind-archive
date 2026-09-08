import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const contractPath = fileURLToPath(
  new URL(
    "../../specs/001-mineru-public-publishing/contracts/openapi.yaml",
    import.meta.url,
  ),
);
function at(
  value: Record<string, unknown>,
  ...keys: readonly string[]
): Record<string, unknown> {
  let current: unknown = value;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      throw new Error(`Missing contract path ${keys.join(".")}`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw new Error(`Contract path is not an object: ${keys.join(".")}`);
  }
  return current as Record<string, unknown>;
}

describe("durable job operation contract", () => {
  it("freezes status, cancellation and immutable-attempt retry operations", async () => {
    const document = parse(await readFile(contractPath, "utf8")) as Record<
      string,
      unknown
    >;
    const status = at(document, "paths", "/api/manage/jobs/{jobId}", "get");
    const cancel = at(
      document,
      "paths",
      "/api/manage/jobs/{jobId}/cancel",
      "post",
    );
    const retry = at(
      document,
      "paths",
      "/api/manage/jobs/{jobId}/retry",
      "post",
    );
    expect(status.operationId).toBe("getJob");
    expect(at(status, "responses")).toHaveProperty("200");
    expect(cancel.operationId).toBe("cancelJob");
    expect(at(cancel, "responses")).toHaveProperty("202");
    expect(at(cancel, "responses")).toHaveProperty("409");
    expect(retry.operationId).toBe("retryJob");
    expect(retry.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          in: "header",
          name: "Idempotency-Key",
          required: true,
        }),
      ]),
    );
    expect(at(retry, "responses")).toHaveProperty("202");
    expect(at(retry, "responses")).toHaveProperty("409");
    const jobSchema = at(document, "components", "schemas", "Job");
    expect(jobSchema.required).toEqual(
      expect.arrayContaining(["attempt", "retry_of_job_id", "subject"]),
    );
    expect(at(jobSchema, "properties")).toHaveProperty("retry_of_job_id");
    expect(at(jobSchema, "properties", "subject")).toMatchObject({
      additionalProperties: false,
      required: ["kind", "label"],
    });
    const kinds = at(jobSchema, "properties", "kind").enum;
    expect(kinds).toEqual(expect.arrayContaining(["build_book"]));
    expect(kinds).not.toEqual(
      expect.arrayContaining(["build_preview", "build_publish"]),
    );
  });
});
