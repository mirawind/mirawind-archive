import type Database from "better-sqlite3";
import { SafeApplicationError } from "@/domain/errors";
import { BuildRepository } from "./builds";
import { DraftRepository } from "./drafts";
import { DocumentRepository } from "./documents";
import { withImmediateTransaction } from "@/platform/sqlite/immediate-transaction";

export function saveDocument(input: {
  bookId: number;
  database: Database.Database;
  expectedUpdatedAt: number;
  patch: unknown;
  requestId: string;
  nowMs: number;
}) {
  if (
    !Number.isSafeInteger(input.expectedUpdatedAt) ||
    input.expectedUpdatedAt < 0 ||
    input.expectedUpdatedAt > 8640000000000000
  )
    throw new SafeApplicationError(
      "DRAFT_TIMESTAMP_INVALID",
      "A valid draft timestamp is required.",
      400,
    );
  const book = new DraftRepository(input.database).findBook(input.bookId);
  const importId = book?.draftImportId;
  if (!importId)
    throw new SafeApplicationError(
      "NOT_FOUND",
      "The draft was not found.",
      404,
    );
  return new DocumentRepository(input.database).edit({
    ...input,
    onChanged: (document) => {
      new BuildRepository(input.database).createForDocument({
        bookId: input.bookId,
        importId,
        sourceUpdatedAt: document.updated_at,
        nowMs: input.nowMs,
        delayMs: 1000,
      });
    },
  });
}

export function requestPreviewBuild(input: {
  bookId: number;
  database: Database.Database;
  expectedUpdatedAt: number;
  nowMs: number;
}) {
  return withImmediateTransaction(input.database, () => {
    const book = new DraftRepository(input.database).findBook(input.bookId);
    if (!book?.draftImportId)
      throw new SafeApplicationError(
        "NOT_FOUND",
        "The draft was not found.",
        404,
      );
    new DocumentRepository(input.database).requireTimestamp(
      input.bookId,
      input.expectedUpdatedAt,
    );
    return new BuildRepository(input.database).createForDocument({
      bookId: input.bookId,
      importId: book.draftImportId,
      sourceUpdatedAt: input.expectedUpdatedAt,
      nowMs: input.nowMs,
    });
  });
}
