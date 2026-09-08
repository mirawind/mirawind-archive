import type { PublishPolicy } from "../publish-policy";

export interface BuildPublicationCapture {
  readonly bookId: number;
  readonly sourceUpdatedAt: number;
  readonly importId: string;
  readonly versionId: string;
  readonly buildId: string;
}
export interface PublishedBuild {
  readonly publishedAtMs: number;
  readonly state: "published";
  readonly versionId: string;
}
export interface BuildPublicationPort {
  capture(input: {
    readonly bookId: number;
    readonly expectedUpdatedAt: number;
    readonly buildId: string;
  }): BuildPublicationCapture;
  promote(input: {
    readonly actorUserId: string | null;
    readonly bookId: number;
    readonly expectedUpdatedAt: number;
    readonly expectedVersionId: string;
    readonly buildId: string;
    readonly nowMs: number;
  }): PublishedBuild;
}
export async function publishBuild(input: {
  readonly actorUserId: string | null;
  readonly bookId: number;
  readonly expectedUpdatedAt: number;
  readonly buildId: string;
  readonly nowMs: number;
  readonly policy: PublishPolicy;
  readonly publication: BuildPublicationPort;
}): Promise<PublishedBuild> {
  const capture = input.publication.capture({
    bookId: input.bookId,
    expectedUpdatedAt: input.expectedUpdatedAt,
    buildId: input.buildId,
  });
  const decision = await input.policy.evaluate({
    bookId: capture.bookId,
    sourceUpdatedAt: capture.sourceUpdatedAt,
    importId: capture.importId,
  });
  if (!decision.allowed) {
    const error = new Error(decision.code);
    error.name = "PublishPolicyError";
    throw error;
  }
  return input.publication.promote({
    actorUserId: input.actorUserId,
    bookId: input.bookId,
    expectedUpdatedAt: input.expectedUpdatedAt,
    expectedVersionId: capture.versionId,
    buildId: input.buildId,
    nowMs: input.nowMs,
  });
}
