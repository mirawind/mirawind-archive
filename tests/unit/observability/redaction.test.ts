import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createLogger } from "@/observability/logger";
import { parseWorkerHealthSnapshot } from "@/observability/worker-health";

describe("structured log redaction", () => {
  it("redacts credentials, cookies, authorization, body content, and unsafe paths", () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createLogger({
      destination,
      service: "test",
    });

    logger.info({
      authorization: "Bearer secret",
      cookie: "session=secret",
      markdown: "private body",
      password: "secret",
      rawArchivePath: "../../private/book.md",
      requestId: "req_visible",
    });

    expect(output).toContain("req_visible");
    expect(output).not.toContain("Bearer secret");
    expect(output).not.toContain("session=secret");
    expect(output).not.toContain("private body");
    expect(output).not.toContain("../../private/book.md");
    expect(output).not.toContain('"password":"secret"');
  });

  it("rejects content-bearing fields from worker health", () => {
    expect(() =>
      parseWorkerHealthSnapshot({
        checkedAt: "2026-08-23T00:00:00.000Z",
        checkpoint: {
          busy: 0,
          checkpointedPages: 0,
          logPages: 0,
          mode: "PASSIVE",
        },
        currentAttempt: null,
        lease: { activeJobs: 0, earliestExpiry: null },
        markdown: "private body",
        queue: {
          observedAtMs: 1,
          oldestQueuedAgeMs: null,
          queuedCount: 0,
          runningCount: 0,
        },
        recentAttempt: null,
        schemaVersion: 3,
        status: "healthy",
        walBytes: 0,
        warnings: [],
      }),
    ).toThrow("WORKER_HEALTH_FIELDS_INVALID");
  });
});
