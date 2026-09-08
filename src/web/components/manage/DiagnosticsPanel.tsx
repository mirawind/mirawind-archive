import { ChevronDown, FilePenLine, LocateFixed } from "lucide-react";
import { useMemo, useState } from "react";

import type { DiagnosticTarget } from "@/domain/errors";
import {
  manageField,
  manageFieldLabel,
  manageQuietButton,
  manageQuietText,
} from "../ui/manage-classes";
import type { PreviewDiagnostic } from "../../contracts/publishing";
import {
  actionableDiagnostics,
  diagnosticSummary,
} from "./diagnostic-presentation";

const diagnosticPageSize = 20;

function targetPage(diagnostic: PreviewDiagnostic): number | null {
  const target = diagnostic.targets?.find(
    (
      candidate,
    ): candidate is Extract<
      DiagnosticTarget,
      { kind: "edit_block" | "select_structure" }
    > =>
      candidate.kind === "edit_block" || candidate.kind === "select_structure",
  );
  return target?.pageId ?? null;
}

function diagnosticTitle(diagnostic: PreviewDiagnostic): string {
  if (diagnostic.code === "MATH_RENDER_FAILED") return "公式未能渲染";
  if (diagnostic.code === "MERMAID_RENDER_INVALID") return "图表未能生成";
  if (diagnostic.code === "CODE_LANGUAGE_UNSUPPORTED") {
    return "代码语言无法识别";
  }
  if (diagnostic.code === "RESOURCE_MISSING_OR_UNSAFE") {
    return "正文资源缺失或不安全";
  }
  if (diagnostic.code.startsWith("PDF_CONTENTS_")) {
    return "PDF 目录证据不足";
  }
  if (diagnostic.code === "PRINTED_TOC_AMBIGUOUS_MATCH") {
    return "目录项对应多个正文标题";
  }
  if (diagnostic.code === "PRINTED_TOC_UNMATCHED_ENTRY") {
    return "目录项没有匹配的正文标题";
  }
  return diagnostic.severity === "error" ? "需要修复" : "建议检查";
}

function TechnicalDetails(props: { readonly diagnostic: PreviewDiagnostic }) {
  const diagnostic = props.diagnostic;
  return (
    <details className="mt-3 text-xs text-stone-600">
      <summary className="cursor-pointer font-medium">技术详情</summary>
      <p>{diagnostic.message}</p>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt>代码</dt>
        <dd className="m-0 break-all">{diagnostic.code}</dd>
        {diagnostic.phase && (
          <>
            <dt>阶段</dt>
            <dd className="m-0">{diagnostic.phase}</dd>
          </>
        )}
        {diagnostic.confidence && (
          <>
            <dt>置信度</dt>
            <dd className="m-0">{diagnostic.confidence}</dd>
          </>
        )}
        {diagnostic.location?.pageIndex !== undefined && (
          <>
            <dt>原 PDF</dt>
            <dd className="m-0">第 {diagnostic.location.pageIndex + 1} 页</dd>
          </>
        )}
        {diagnostic.location?.regionId && (
          <>
            <dt>区域</dt>
            <dd className="m-0 break-all">{diagnostic.location.regionId}</dd>
          </>
        )}
      </dl>
      {diagnostic.evidence?.length ? (
        <p className="mb-0">依据：{diagnostic.evidence.join("；")}</p>
      ) : null}
    </details>
  );
}

export function DiagnosticsPanel(props: {
  readonly diagnostics: readonly PreviewDiagnostic[];
  readonly onTarget?: (
    target: DiagnosticTarget,
    diagnostic: PreviewDiagnostic,
  ) => void;
}) {
  const diagnostics = actionableDiagnostics(props.diagnostics);
  const [severity, setSeverity] = useState<
    "all" | "error" | "info" | "warning"
  >("all");
  const [pageId, setPageId] = useState<"all" | number>("all");
  const [visibleCount, setVisibleCount] = useState(diagnosticPageSize);
  const pageIds = useMemo(
    () =>
      [
        ...new Set(
          diagnostics.flatMap((diagnostic) => {
            const page = targetPage(diagnostic);
            return page === null ? [] : [page];
          }),
        ),
      ].sort((left, right) => left - right),
    [diagnostics],
  );
  if (diagnostics.length === 0) return null;

  const filtered = diagnostics.filter((diagnostic) => {
    const diagnosticSeverity = diagnostic.severity ?? "warning";
    if (severity !== "all" && severity !== diagnosticSeverity) return false;
    if (pageId === "all") return true;
    return targetPage(diagnostic) === pageId;
  });
  const visible = filtered.slice(0, visibleCount);
  const hiddenCount = filtered.length - visible.length;
  const summary = diagnosticSummary(diagnostics);
  return (
    <section className="diagnostics-panel" aria-labelledby="diagnostics-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-bold" id="diagnostics-title">
          问题与建议
        </h2>
        <p className={manageQuietText}>
          {summary.errors > 0 ? `${summary.errors} 项需要修复` : "没有阻断项"}
          {summary.warnings > 0 ? ` · ${summary.warnings} 项建议检查` : ""}
        </p>
      </div>
      <div className="diagnostic-filters mt-4 grid grid-cols-2 gap-3">
        <label className={manageFieldLabel}>
          类型
          <select
            className={manageField}
            onChange={(event) => {
              setSeverity(event.currentTarget.value as typeof severity);
              setVisibleCount(diagnosticPageSize);
            }}
            value={severity}
          >
            <option value="all">全部</option>
            <option value="error">需要修复</option>
            <option value="warning">建议检查</option>
            <option value="info">信息</option>
          </select>
        </label>
        <label className={manageFieldLabel}>
          页面
          <select
            className={manageField}
            onChange={(event) => {
              setPageId(
                event.currentTarget.value === "all"
                  ? "all"
                  : Number(event.currentTarget.value),
              );
              setVisibleCount(diagnosticPageSize);
            }}
            value={pageId}
          >
            <option value="all">全部</option>
            {pageIds.map((page) => (
              <option key={page} value={page}>
                第 {page} 页
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className={`mt-3 ${manageQuietText}`}>
        显示 {visible.length} / {filtered.length}
      </p>
      <ul className="grid gap-3 p-0">
        {visible.map((diagnostic, index) => {
          const severityValue = diagnostic.severity ?? "warning";
          const targets = diagnostic.targets;
          return (
            <li
              className={`list-none border-l-4 p-4 text-sm ${
                severityValue === "error"
                  ? "border-red-600 bg-red-50 text-red-900"
                  : severityValue === "info"
                    ? "border-stone-400 bg-stone-50 text-stone-800"
                    : "border-amber-500 bg-amber-50 text-amber-900"
              }`}
              key={`${index}:${diagnostic.code}`}
            >
              <strong>{diagnosticTitle(diagnostic)}</strong>
              {props.onTarget && targets?.length ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {targets.map((target) => (
                    <button
                      className={manageQuietButton}
                      key={`${target.kind}:${target.blockId}`}
                      onClick={() => props.onTarget?.(target, diagnostic)}
                      type="button"
                    >
                      {target.kind === "select_structure" ? (
                        <LocateFixed aria-hidden="true" size={16} />
                      ) : (
                        <FilePenLine aria-hidden="true" size={16} />
                      )}
                      {target.kind === "select_structure"
                        ? "定位结构"
                        : "编辑正文"}
                    </button>
                  ))}
                </div>
              ) : null}
              <TechnicalDetails diagnostic={diagnostic} />
            </li>
          );
        })}
      </ul>
      {hiddenCount > 0 && (
        <div className="flex justify-center">
          <button
            className={manageQuietButton}
            onClick={() =>
              setVisibleCount((current) => current + diagnosticPageSize)
            }
            type="button"
          >
            <ChevronDown aria-hidden="true" size={16} />
            再显示 {Math.min(diagnosticPageSize, hiddenCount)} 条
          </button>
        </div>
      )}
    </section>
  );
}
