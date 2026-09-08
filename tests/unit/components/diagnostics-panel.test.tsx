// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DiagnosticsPanel } from "@/web/components/manage/DiagnosticsPanel";

afterEach(cleanup);

describe("workbench diagnostics", () => {
  it("omits empty and automatic typography diagnostics from the workbench", () => {
    const view = render(<DiagnosticsPanel diagnostics={[]} />);
    expect(view.container.childElementCount).toBe(0);
    view.rerender(
      <DiagnosticsPanel
        diagnostics={[
          {
            code: "TYPOGRAPHY_PUNCTUATION_REWRITE",
            message: "Typography changed a mixed source range.",
            phase: "typography",
            severity: "warning",
          },
        ]}
      />,
    );
    expect(view.container.childElementCount).toBe(0);
  });

  it("does not render an action for informational evidence locations", () => {
    const view = render(
      <DiagnosticsPanel
        diagnostics={[
          {
            code: "PDF_CONTENTS_OCR_LOW_CONFIDENCE",
            location: {
              pageIndex: 2,
              regionId: "region_abcdefghijklmnop",
            },
            message: "Bounded OCR evidence was insufficient.",
            phase: "ocr",
            severity: "warning",
          },
        ]}
        onTarget={() => undefined}
      />,
    );

    expect(view.queryAllByRole("button")).toHaveLength(0);
  });

  it("dispatches only explicit executable targets", () => {
    const onTarget = vi.fn();
    const view = render(
      <DiagnosticsPanel
        diagnostics={[
          {
            code: "MATH_RENDER_FAILED",
            message: "The formula remains editable source.",
            targets: [
              {
                blockId: "blk_abcdefghijklmnop",
                kind: "edit_block",
                pageId: 3,
              },
            ],
          },
        ]}
        onTarget={onTarget}
      />,
    );

    fireEvent.click(view.getByRole("button"));
    expect(onTarget).toHaveBeenCalledExactlyOnceWith(
      { blockId: "blk_abcdefghijklmnop", kind: "edit_block", pageId: 3 },
      expect.objectContaining({ code: "MATH_RENDER_FAILED" }),
    );
  });

  it("bounds initial diagnostics and loads the rest on demand", () => {
    const view = render(
      <DiagnosticsPanel
        diagnostics={Array.from({ length: 25 }, (_value, index) => ({
          code: `TEST_DIAGNOSTIC_${index}`,
          message: `Diagnostic ${index}`,
        }))}
      />,
    );

    expect(view.getAllByRole("listitem")).toHaveLength(20);
    fireEvent.click(view.getByRole("button"));
    expect(view.getAllByRole("listitem")).toHaveLength(25);
    expect(view.queryAllByRole("button")).toHaveLength(0);
  });
});
