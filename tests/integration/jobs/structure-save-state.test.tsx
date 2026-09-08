// @vitest-environment happy-dom
import { createRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StructureEditor,
  type StructureEditorHandle,
  type StructureEditorState,
} from "@/web/components/manage/StructureEditor";
import { readSaveResult } from "@/web/components/manage/save-result";

vi.mock("@/web/components/manage/save-result", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/web/components/manage/save-result")
  >()),
  readSaveResult: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const blockId = "blk_structure_save_state_0001";
function node(title: string) {
  return {
    block_id: blockId,
    display_level: 1,
    title_markdown: title,
    starts_page: true,
    include_in_toc: true,
    exclude_from_numbering: false,
  };
}
const common = {
  bookId: 1,
  boundaries: { body_start_block_id: blockId },
  headings: [],
  numbering: "source" as const,
};
const field = () =>
  screen.getAllByLabelText("标题", { exact: true })[0] as HTMLInputElement;

describe("structure save state", () => {
  it("retains typing made while the server saves the submitted edit", async () => {
    let resolveSave!: (timestamp: number) => void;
    vi.mocked(readSaveResult).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ updated_at: 2000 }, { status: 200 }),
        ),
    );
    const ref = createRef<StructureEditorHandle>();
    let state: StructureEditorState | undefined;
    const onStateChange = (next: StructureEditorState) => {
      state = next;
    };
    const onSaved = async () => {
      view.rerender(
        <StructureEditor
          {...common}
          ref={ref}
          updatedAt={2000}
          structure={[node("Submitted")]}
          onSaved={onSaved}
          onStateChange={onStateChange}
        />,
      );
    };
    const view = render(
      <StructureEditor
        {...common}
        ref={ref}
        updatedAt={1000}
        structure={[node("Initial")]}
        onSaved={onSaved}
        onStateChange={onStateChange}
      />,
    );
    fireEvent.change(field(), { target: { value: "Submitted" } });
    act(() => ref.current?.save());
    await waitFor(() => expect(readSaveResult).toHaveBeenCalled());
    fireEvent.change(field(), { target: { value: "Typed later" } });
    await act(async () => resolveSave(2000));
    await waitFor(() =>
      expect(state).toEqual({ saving: false, dirty: true, conflict: false }),
    );
    expect(field().value).toBe("Typed later");
  });
  it("does not silently rebase unsaved changes onto an external save", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const ref = createRef<StructureEditorHandle>();
    let state: StructureEditorState | undefined;
    const onStateChange = (next: StructureEditorState) => {
      state = next;
    };
    const onSaved = async () => {};
    const view = render(
      <StructureEditor
        {...common}
        ref={ref}
        updatedAt={1000}
        structure={[node("Initial")]}
        onSaved={onSaved}
        onStateChange={onStateChange}
      />,
    );
    fireEvent.change(field(), { target: { value: "Local" } });
    view.rerender(
      <StructureEditor
        {...common}
        ref={ref}
        updatedAt={2000}
        structure={[node("External")]}
        onSaved={onSaved}
        onStateChange={onStateChange}
      />,
    );
    await waitFor(() => expect(state?.conflict).toBe(true));
    expect(field().value).toBe("Local");
    act(() => ref.current?.save());
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("clears a no-op edit without requiring a new timestamp", async () => {
    vi.mocked(readSaveResult).mockResolvedValue(1000);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ updated_at: 2000 }, { status: 200 }),
        ),
    );
    const ref = createRef<StructureEditorHandle>();
    let state: StructureEditorState | undefined;
    render(
      <StructureEditor
        {...common}
        ref={ref}
        updatedAt={1000}
        structure={[node("**Title**")]}
        onSaved={async () => {}}
        onStateChange={(next) => {
          state = next;
        }}
      />,
    );
    fireEvent.change(field(), { target: { value: "__Title__" } });
    act(() => ref.current?.save());
    await waitFor(() =>
      expect(state).toEqual({ saving: false, dirty: false, conflict: false }),
    );
    expect(field().value).toBe("**Title**");
  });
});
