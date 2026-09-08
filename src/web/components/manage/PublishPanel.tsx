import { Upload } from "lucide-react";
import { useState } from "react";

import { managePrimaryButton } from "../ui/manage-classes";

export function PublishPanel(props: {
  readonly blocked?: boolean;
  readonly bookId: number;
  readonly buildPublished: boolean;
  readonly compact?: boolean;
  readonly updatedAt: number;
  readonly buildId: string | null;
  readonly onPublished: () => Promise<void>;
  readonly previewReady: boolean;
  readonly previewStale: boolean;
}) {
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function publish() {
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch(
        `/api/manage/books/${props.bookId}/publish`,
        {
          body: JSON.stringify({
            expected_updated_at: props.updatedAt,
            build_id: props.buildId,
          }),
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
        },
      );
      if (!response.ok) {
        setMessage(
          response.status === 412
            ? "草稿已更新，请重新载入后再发布。"
            : response.status === 409
              ? "当前候选已过期或存在阻断问题。"
              : "无法发布，请稍后重试。",
        );
        return;
      }
      await props.onPublished();
    } catch {
      setMessage("无法发布，请检查网络后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  const canPublish =
    props.previewReady &&
    Boolean(props.buildId) &&
    !props.previewStale &&
    !props.blocked &&
    !submitting &&
    !props.buildPublished;
  const publishLabel = submitting
    ? "正在发布"
    : props.buildPublished
      ? "已发布"
      : "发布当前预览";

  return (
    <section
      aria-label="发布"
      className={`publish-panel ${
        props.compact
          ? "publish-panel-compact flex items-center gap-2 max-[850px]:row-start-2 max-[480px]:col-span-full max-[480px]:row-start-4"
          : ""
      }`}
    >
      <button
        aria-label={publishLabel}
        className={`${managePrimaryButton} whitespace-nowrap`}
        disabled={!canPublish}
        onClick={() => void publish()}
        title={publishLabel}
        type="button"
      >
        {props.compact && <Upload aria-hidden="true" size={18} />}
        <span className={props.compact ? "max-[480px]:sr-only" : undefined}>
          {publishLabel}
        </span>
      </button>
      {props.buildPublished && (
        <a
          className="font-semibold text-emerald-800 hover:text-emerald-900"
          href={`/read/${props.bookId}`}
        >
          开始阅读
        </a>
      )}
      {props.previewStale && (
        <p className="stale max-w-72 text-sm text-amber-800">预览已过期</p>
      )}
      {message && (
        <p className="max-w-72 text-sm text-red-800" role="alert">
          {message}
        </p>
      )}
    </section>
  );
}
