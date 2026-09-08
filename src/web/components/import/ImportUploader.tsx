import { type ComponentProps, useEffect, useRef, useState } from "react";
import { FileArchive, Upload, X } from "lucide-react";

import type { JobProgress } from "@/entrypoints/worker/protocol";
import {
  manageFieldLabel,
  managePanel,
  managePrimaryButton,
  manageSecondaryButton,
} from "../ui/manage-classes";
import { usePolling } from "../manage/use-polling";

import { CandidateReview, type CandidateView } from "./CandidateReview";
import {
  jobProgressDetail,
  jobProgressPercent,
  jobProgressSummary,
} from "./job-presentation";

type FormSubmitEvent = Parameters<
  NonNullable<ComponentProps<"form">["onSubmit"]>
>[0];

type JobState =
  "canceled" | "failed" | "interrupted" | "queued" | "running" | "succeeded";

interface JobView {
  readonly attempt: number;
  readonly cancellation_requested_at: string | null;
  readonly error_class: string | null;
  readonly error_code: string | null;
  readonly job_id: string;
  readonly kind: string;
  readonly phase: string;
  readonly progress: JobProgress;
  readonly state: JobState;
  readonly subject: {
    readonly kind: "book" | "import" | "system";
    readonly label: string;
  };
}

interface ImportView {
  readonly book_id: number | null;
  readonly candidates: readonly CandidateView[];
  readonly current_job: JobView | null;
  readonly error_code: string | null;
  readonly import_id: string;
  readonly preview: {
    readonly source_updated_at: number | null;
    readonly state: "building" | "failed" | "ready" | "unavailable";
    readonly url: string | null;
  };
  readonly source_name: string;
  readonly state: string;
}

interface UploadResult {
  readonly body: {
    readonly code?: string;
    readonly import_id?: string;
  };
  readonly status: number;
}

const terminalJobStates = new Set<JobState>([
  "canceled",
  "failed",
  "interrupted",
  "succeeded",
]);

const workflowStages = [
  ["upload", "上传"],
  ["extract_archive", "解包"],
  ["identify_document", "识别正文"],
  ["organize_structure", "整理结构"],
  ["build_candidate", "生成阅读预览"],
] as const;

function workflowStage(
  uploadState: "accepting" | "idle" | "uploading",
  imported: ImportView | null,
): (typeof workflowStages)[number][0] {
  if (uploadState !== "idle" || !imported) return "upload";
  const job = imported.current_job;
  if (job?.kind === "build_candidate") return "build_candidate";
  if (job?.phase === "organize_structure") return "organize_structure";
  if (job?.phase === "identify_document") return "identify_document";
  if (job?.phase === "extract_archive" || imported.state === "analyzing") {
    return "extract_archive";
  }
  return imported.preview.state === "ready" ? "build_candidate" : "upload";
}

function sendUpload(input: {
  readonly file: File;
  readonly idempotencyKey: string;
  readonly onProgress: (loaded: number, total: number) => void;
  readonly onRequest: (request: XMLHttpRequest | null) => void;
}): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    input.onRequest(request);
    request.open("POST", "/api/manage/imports");
    request.withCredentials = true;
    request.setRequestHeader("Accept", "application/json");
    request.setRequestHeader("Idempotency-Key", input.idempotencyKey);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) input.onProgress(event.loaded, event.total);
    };
    request.onerror = () => reject(new Error("UPLOAD_NETWORK_FAILED"));
    request.onabort = () => reject(new Error("UPLOAD_ABORTED"));
    request.onload = () => {
      input.onRequest(null);
      const body = (() => {
        try {
          return JSON.parse(request.responseText) as UploadResult["body"];
        } catch {
          return {};
        }
      })();
      resolve({ body, status: request.status });
    };
    const body = new FormData();
    body.set("file", input.file);
    request.send(body);
  });
}

export function ImportUploader() {
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const [importView, setImportView] = useState<ImportView | null>(null);
  const [uploadBytes, setUploadBytes] = useState({ loaded: 0, total: 0 });
  const [uploadState, setUploadState] = useState<
    "accepting" | "idle" | "uploading"
  >("idle");
  const fileInput = useRef<HTMLInputElement>(null);
  const idempotencyKey = useRef(crypto.randomUUID());
  const uploadRequest = useRef<XMLHttpRequest | null>(null);

  useEffect(() => {
    const selected = fileInput.current?.files?.[0];
    if (!selected) return;
    setFile(selected);
    idempotencyKey.current = crypto.randomUUID();
    setUploadBytes({ loaded: 0, total: selected.size });
  }, []);

  async function refresh(importId: string) {
    const response = await fetch(`/api/manage/imports/${importId}`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("IMPORT_STATUS_FAILED");
    setImportView((await response.json()) as ImportView);
  }

  const importJobTerminal =
    importView?.current_job &&
    terminalJobStates.has(importView.current_job.state);
  const shouldPoll =
    importView !== null &&
    importView.preview.state !== "ready" &&
    importView.preview.state !== "failed" &&
    !(importJobTerminal && importView.current_job?.state !== "succeeded") &&
    !["rejected", "canceled", "expired"].includes(importView.state);
  usePolling(shouldPoll, async () => {
    if (!importView) return;
    await refresh(importView.import_id).catch(() =>
      setMessage("状态刷新失败，请稍后重试。"),
    );
  });

  async function upload(event: FormSubmitEvent) {
    event.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    setMessage("");
    setUploadBytes({ loaded: 0, total: file.size });
    setUploadState("uploading");
    try {
      const result = await sendUpload({
        file,
        idempotencyKey: idempotencyKey.current,
        onProgress(loaded, total) {
          setUploadBytes((current) => ({
            loaded: Math.max(current.loaded, loaded),
            total,
          }));
          if (loaded >= total) setUploadState("accepting");
        },
        onRequest(request) {
          uploadRequest.current = request;
        },
      });
      if (result.status !== 202 || !result.body.import_id) {
        setMessage(`上传失败：${result.body.code ?? "UPLOAD_FAILED"}`);
        setUploadState("idle");
        return;
      }
      await refresh(result.body.import_id);
      idempotencyKey.current = crypto.randomUUID();
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      setUploadState("idle");
    } catch (error) {
      setUploadState("idle");
      setMessage(
        error instanceof Error && error.message === "UPLOAD_ABORTED"
          ? "上传已取消。"
          : "网络中断，请重试。",
      );
    } finally {
      uploadRequest.current = null;
      setBusy(false);
    }
  }

  async function cancelBackgroundJob() {
    const job = importView?.current_job;
    if (!job || terminalJobStates.has(job.state)) return;
    setBusy(true);
    const response = await fetch(`/api/manage/jobs/${job.job_id}/cancel`, {
      credentials: "same-origin",
      method: "POST",
    });
    if (!response.ok) setMessage("无法取消后台任务，请稍后重试。");
    else await refresh(importView.import_id);
    setBusy(false);
  }

  const currentStage = workflowStage(uploadState, importView);
  const uploadPercent =
    uploadBytes.total > 0
      ? Math.min(
          100,
          Math.floor((uploadBytes.loaded / uploadBytes.total) * 100),
        )
      : 0;
  const backgroundPercent = importView?.current_job
    ? jobProgressPercent(
        importView.current_job.state,
        importView.current_job.progress,
      )
    : null;

  return (
    <div
      className={`import-workspace grid gap-6 ${importView ? "min-[761px]:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]" : "max-w-2xl"}`}
    >
      <form className={`upload-card ${managePanel}`} onSubmit={upload}>
        <h1 className="mt-2 text-2xl font-bold text-stone-900">准备一本书</h1>
        <div className={manageFieldLabel}>
          <span>MinerU ZIP（最大 2 GiB）</span>
          <div className="flex min-h-11 items-center gap-3 rounded-md border border-stone-400 bg-white p-1.5">
            <label
              className={`${manageSecondaryButton} shrink-0 cursor-pointer`}
              htmlFor="mineru-zip"
            >
              <FileArchive aria-hidden="true" size={18} />
              选择 ZIP
            </label>
            <span
              className="min-w-0 truncate text-sm text-stone-700"
              id="mineru-zip-name"
            >
              {file?.name ?? "未选择文件"}
            </span>
          </div>
          <input
            accept=".zip,application/zip"
            aria-describedby="mineru-zip-name"
            aria-label="MinerU ZIP"
            className="sr-only"
            disabled={uploadState !== "idle"}
            id="mineru-zip"
            name="file"
            onChange={(event) => {
              const next = event.currentTarget.files?.[0] ?? null;
              setFile(next);
              idempotencyKey.current = crypto.randomUUID();
              setMessage("");
              setUploadBytes({ loaded: 0, total: next?.size ?? 0 });
            }}
            ref={fileInput}
            required
            type="file"
          />
        </div>
        <div className="upload-actions flex flex-wrap gap-2">
          <button
            className={managePrimaryButton}
            disabled={!file || busy}
            type="submit"
          >
            <Upload aria-hidden="true" size={18} />
            {uploadState === "uploading" ? "上传中" : "上传并分析"}
          </button>
          {uploadState !== "idle" && (
            <button
              className={manageSecondaryButton}
              onClick={() => uploadRequest.current?.abort()}
              type="button"
            >
              <X aria-hidden="true" size={18} />
              取消
            </button>
          )}
        </div>
        {uploadState !== "idle" && (
          <div aria-label={`上传进度 ${uploadPercent}%`} className="mt-4">
            <progress
              className="h-2 w-full accent-emerald-700"
              max={100}
              value={uploadPercent}
            />
            <p className="mt-2 text-sm text-stone-600">
              {uploadState === "accepting"
                ? "正在保存并排队"
                : `${uploadBytes.loaded.toLocaleString()} / ${uploadBytes.total.toLocaleString()} 字节 · ${uploadPercent}%`}
            </p>
          </div>
        )}
        {message && (
          <p className="mt-3 text-sm text-red-800" role="alert">
            {message}
          </p>
        )}
      </form>

      {importView && (
        <section className={`status-card ${managePanel}`} aria-live="polite">
          <h2 className="text-lg font-bold text-stone-900">处理进度</h2>
          <ol className="import-stages mt-4 grid list-none grid-cols-1 gap-2 p-0 min-[761px]:grid-cols-5">
            {workflowStages.map(([key, label]) => (
              <li
                aria-current={currentStage === key ? "step" : undefined}
                className={`border-t-4 pt-2 text-sm ${
                  currentStage === key
                    ? "border-emerald-700 font-semibold text-stone-900"
                    : "border-stone-300 text-stone-600"
                }`}
                data-active={currentStage === key}
                key={key}
              >
                {label}
              </li>
            ))}
          </ol>
          <div className="mt-4 flex min-w-0 items-center gap-2">
            <FileArchive
              aria-hidden="true"
              className="shrink-0 text-emerald-800"
              size={20}
            />
            <strong className="truncate text-stone-900">
              {importView.source_name}
            </strong>
          </div>
          {importView.error_code && (
            <p className="diagnostic mt-4 text-red-800">
              {importView.error_code}
            </p>
          )}
          {importView.current_job &&
            importView.current_job.state !== "succeeded" && (
              <div className="job-progress mt-4">
                <div
                  aria-label={
                    backgroundPercent === null
                      ? "后台处理进度未知"
                      : `后台处理进度 ${backgroundPercent}%`
                  }
                >
                  <progress
                    className="h-2 w-full accent-emerald-700"
                    max={100}
                    {...(backgroundPercent === null
                      ? {}
                      : { value: backgroundPercent })}
                  />
                </div>
                <p className="mt-2 font-medium text-stone-800">
                  {jobProgressSummary(importView.current_job)}
                </p>
                {jobProgressDetail(importView.current_job.progress) && (
                  <p className="mt-1 text-sm text-stone-600">
                    {jobProgressDetail(importView.current_job.progress)}
                  </p>
                )}
                {importView.current_job.error_class && (
                  <p className="diagnostic text-red-800">
                    {importView.current_job.error_class} ·{" "}
                    {importView.current_job.error_code}
                  </p>
                )}
                {!terminalJobStates.has(importView.current_job.state) && (
                  <button
                    className={manageSecondaryButton}
                    disabled={busy}
                    onClick={() => void cancelBackgroundJob()}
                    type="button"
                  >
                    取消后台处理
                  </button>
                )}
              </div>
            )}
          {importView.preview.url && (
            <a
              className="mt-4 inline-flex font-semibold text-emerald-800 hover:text-emerald-900"
              href={importView.preview.url}
            >
              打开出版工作台
            </a>
          )}
          {importView.state === "rejected" && (
            <CandidateReview candidates={importView.candidates} />
          )}
        </section>
      )}
    </div>
  );
}
