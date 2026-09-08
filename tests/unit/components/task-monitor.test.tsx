// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  TaskMonitor,
  type TaskView,
} from "@/web/components/import/TaskMonitor";

afterEach(cleanup);

function task(
  index: number,
  state: TaskView["state"],
  kind = state === "running" ? "build_book" : "verify_version",
): TaskView {
  return Object.freeze({
    attempt: 1,
    automatic_retry_count: 0,
    cancellation_requested_at: null,
    created_at: new Date(Date.UTC(2026, 7, 24, 2, index)).toISOString(),
    error_class: state === "failed" ? "content" : null,
    error_code: state === "failed" ? "TEST_FAILURE" : null,
    finished_at: state === "running" ? null : new Date().toISOString(),
    job_id: `job_${String(index).padStart(24, "0")}`,
    kind,
    phase: state === "running" ? "render_pages" : "complete",
    progress: Object.freeze({
      completed: state === "running" ? 2 : 1,
      processed_bytes: null,
      total: state === "running" ? 4 : 1,
      unit: state === "running" ? "pages" : "steps",
    }),
    retry_of_job_id: null,
    started_at: new Date().toISOString(),
    state,
    subject: Object.freeze({
      kind: "book" as const,
      label: `Book ${index}`,
    }),
  });
}

describe("task monitor history", () => {
  it("keeps active and actionable work visible while bounding completed history", () => {
    const jobs = [
      task(20, "running"),
      task(19, "failed", "build_book"),
      ...Array.from({ length: 12 }, (_value, index) =>
        task(18 - index, "succeeded", "build_book"),
      ),
    ];
    const view = render(<TaskMonitor initialJobs={jobs} />);
    const rows = () => view.container.querySelectorAll("[data-job-id]");
    expect(rows()).toHaveLength(10);
    expect(
      Array.from(rows(), (row) => row.getAttribute("data-job-id")),
    ).toEqual(jobs.slice(0, 10).map((job) => job.job_id));
    fireEvent.click(view.getByRole("button", { name: /显示其余/ }));
    expect(rows()).toHaveLength(jobs.length);
  });

  it("keeps all internal maintenance out of the user task list", () => {
    const view = render(
      <TaskMonitor
        initialJobs={[
          task(3, "succeeded", "verify_version"),
          task(2, "succeeded", "reclaim"),
          task(1, "failed", "reconcile"),
        ]}
      />,
    );

    expect(view.queryAllByRole("listitem")).toHaveLength(0);
    expect(view.queryAllByRole("button")).toHaveLength(0);
  });
});
