import type { JobProgress } from "@/entrypoints/worker/protocol";

type JobState =
  "canceled" | "failed" | "interrupted" | "queued" | "running" | "succeeded";

const operationLabels: Readonly<Record<string, string>> = Object.freeze({
  analyze_import: "分析导入",
  build_book: "生成阅读预览",
  permanent_book_deletion: "永久删除图书",
  prepare_draft: "整理草稿",
});

const phaseLabels: Readonly<Record<string, string>> = Object.freeze({
  build_search: "构建搜索",
  canceled: "已取消",
  compile_book: "编译全书",
  complete: "已完成",
  failed: "处理失败",
  finalize_build: "完成预览",
  identify_document: "识别正文",
  interrupted: "处理已中断",
  organize_structure: "整理结构",
  permanent_book_deletion: "永久删除",
  queued: "等待后台处理",
  render_pages: "渲染页面",
  extract_archive: "解包",
  starting: "正在启动",
  validate_edit: "校验修改",
  prepare_save: "保存正文",
  succeeded: "已完成",
});

const unitLabels: Readonly<Record<JobProgress["unit"], string>> = Object.freeze(
  {
    bytes: "字节",
    items: "项",
    pages: "页",
    steps: "步",
  },
);

export function jobOperationLabel(kind: string): string {
  return operationLabels[kind] ?? "后台任务";
}

export function jobPhaseLabel(phase: string): string {
  return phaseLabels[phase] ?? "正在处理";
}

export function jobProgressPercent(
  state: JobState,
  progress: JobProgress,
): number | null {
  if (state === "succeeded") return 100;
  if (progress.total === null || progress.total <= 0) return null;
  return Math.min(
    100,
    Math.max(0, Math.floor((progress.completed / progress.total) * 100)),
  );
}

export function jobProgressSummary(input: {
  readonly phase: string;
  readonly progress: JobProgress;
  readonly state: JobState;
}): string {
  const percent = jobProgressPercent(input.state, input.progress);
  if (percent === null) {
    return input.state === "queued"
      ? "等待后台处理"
      : jobPhaseLabel(input.phase);
  }
  return `${jobPhaseLabel(input.phase)} · ${percent}%`;
}

export function jobProgressDetail(progress: JobProgress): string | null {
  if (progress.total === null) return null;
  return `${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()} ${unitLabels[progress.unit]}`;
}
