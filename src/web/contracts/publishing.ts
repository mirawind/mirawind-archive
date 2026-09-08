import type { SafeDiagnostic } from "@/domain/errors";
import type {
  BuildView,
  HeadingNumberingMode,
} from "@/modules/publishing/application/publishing-api";

export type PreviewDiagnostic = SafeDiagnostic;

export interface PreviewHeading {
  readonly block_id: string;
  readonly display_level: number;
  readonly include_in_toc: boolean;
  readonly page_id: number | null;
  readonly source_number: string | null;
  readonly exclude_from_numbering: boolean;
  readonly starts_page: boolean;
  readonly title: string;
  readonly title_markdown: string;
}

export interface PreviewPage {
  readonly page_id: number;
  readonly title: string;
}

export interface DraftView {
  readonly access: "private" | "public";
  readonly alias: string | null;
  readonly boundaries: {
    readonly appendix_start_block_id?: string;
    readonly backmatter_start_block_id?: string;
    readonly body_start_block_id: string;
  };
  readonly book_id: number;
  readonly build: BuildView | null;
  readonly build_published: boolean;
  readonly updated_at: number;
  readonly diagnostics: readonly PreviewDiagnostic[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly numbering: HeadingNumberingMode;
  readonly published: boolean;
  readonly preview: {
    readonly build_id: string;
    readonly boundaries: DraftView["boundaries"];
    readonly compiler_version: string;
    readonly source_updated_at: number;
    readonly headings: readonly PreviewHeading[];
    readonly is_stale: boolean;
    readonly pages: readonly PreviewPage[];
    readonly renderer_version: string;
    readonly semantic_digest: string;
  } | null;
  readonly structure: readonly {
    readonly block_id: string;
    readonly display_level: number;
    readonly include_in_toc: boolean;
    readonly exclude_from_numbering: boolean;
    readonly source_number?: string;
    readonly starts_page: boolean;
    readonly title_markdown: string;
  }[];
  readonly title: string;
}

export interface RecoveryJob {
  readonly error_code: string | null;
  readonly job_id: string;
  readonly state:
    "canceled" | "failed" | "interrupted" | "queued" | "running" | "succeeded";
}
