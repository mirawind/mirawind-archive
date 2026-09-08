import { describe, expect, it, vi } from "vitest";

import { createSafeDiagnostic } from "@/domain/errors";

it("preserves safe errors across module reloads without trusting JSON lookalikes", async () => {
  const { SafeApplicationError } = await import("@/domain/errors");
  const previousError = new SafeApplicationError(
    "INVALID_ORIGIN",
    "Origin rejected.",
    403,
  );
  vi.resetModules();
  const { safeErrorInputFromUnknown } = await import("@/http/errors/responses");
  expect(
    safeErrorInputFromUnknown({ cause: previousError, requestId: "req_test" }),
  ).toMatchObject({
    status: 403,
    code: "INVALID_ORIGIN",
  });
  expect(
    safeErrorInputFromUnknown({
      cause: JSON.parse(JSON.stringify(previousError)),
      requestId: "req_test",
    }),
  ).toMatchObject({ status: 500, code: "INTERNAL_SERVER_ERROR" });
});

describe("safe locatable diagnostics", () => {
  it("retains bounded evidence, location and executable targets", () => {
    const diagnostic = createSafeDiagnostic({
      code: "PRINTED_TOC_UNMATCHED_ENTRY",
      confidence: "low",
      evidence: ["numbering", "x".repeat(500)],
      location: {
        blockId: "blk_abcdefghijklmnop",
        pageIndex: 3,
        regionId: "region_abcdefghijklmnop",
      },
      message: "No unique body heading was found.",
      phase: "matching",
      severity: "warning",
      targets: [
        {
          blockId: "blk_abcdefghijklmnop",
          kind: "select_structure",
          pageId: 4,
        },
      ],
    });

    expect(diagnostic).toMatchObject({
      confidence: "low",
      location: { pageIndex: 3 },
      phase: "matching",
      targets: [
        {
          blockId: "blk_abcdefghijklmnop",
          kind: "select_structure",
          pageId: 4,
        },
      ],
    });
    expect(diagnostic.evidence?.[1]).toHaveLength(200);
    expect(diagnostic.location?.blockId).toBe("blk_abcdefghijklmnop");
    expect(diagnostic.location?.regionId).toBe("region_abcdefghijklmnop");
  });

  it("drops invalid identifiers and enum values from generated input", () => {
    const diagnostic = createSafeDiagnostic({
      code: "LAYOUT_EVIDENCE_INVALID",
      confidence: "unknown" as "low",
      location: {
        blockId: "private body text",
        regionId: "raw/archive/path",
      },
      message: "Invalid evidence.",
      phase: "unknown" as "contents",
      targets: [
        {
          blockId: "private body text",
          kind: "edit_block",
          pageId: 0,
        },
      ],
    });

    expect(diagnostic.confidence).toBeUndefined();
    expect(diagnostic.phase).toBeUndefined();
    expect(diagnostic.targets).toBeUndefined();
    expect(diagnostic.location).toBeUndefined();
  });

  it("drops unknown target kinds", () => {
    const diagnostic = createSafeDiagnostic({
      code: "PRINTED_TOC_LOW_CONFIDENCE",
      message: "The automatic evidence was insufficient.",
      targets: [
        {
          blockId: "blk_abcdefghijklmnop",
          kind: "enable_region",
          pageId: 1,
        } as never,
      ],
    });

    expect(diagnostic.targets).toBeUndefined();
  });

  it("deduplicates executable targets", () => {
    const target = {
      blockId: "blk_abcdefghijklmnop",
      kind: "edit_block" as const,
      pageId: 2,
    };
    const diagnostic = createSafeDiagnostic({
      code: "MATH_RENDER_FAILED",
      message: "The formula remains editable source.",
      targets: [target, target],
    });

    expect(diagnostic.targets).toEqual([target]);
  });
});
