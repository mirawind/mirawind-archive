export class DraftSaveFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DraftSaveFailure";
  }
}
export async function readSaveResult(response: Response): Promise<number> {
  const result = (await response.json()) as {
    updated_at?: unknown;
    code?: string;
  };
  if (!response.ok)
    throw new DraftSaveFailure(result.code ?? "DRAFT_SAVE_FAILED");
  if (
    typeof result.updated_at !== "number" ||
    !Number.isSafeInteger(result.updated_at) ||
    result.updated_at < 0
  )
    throw new DraftSaveFailure("DRAFT_SAVE_RESPONSE_INVALID");
  return result.updated_at;
}
