export interface BuildView {
  readonly id: string;
  readonly job_id: string;
  readonly state: "building" | "ready" | "failed" | "canceled" | "interrupted";
  readonly source_updated_at: number;
  readonly safe_error_code: string | null;
}
