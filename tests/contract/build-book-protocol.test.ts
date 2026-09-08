import { describe, expect, it } from "vitest";

import { createOpaqueId } from "@/domain/ids";
import {
  parseBuildBookCommand,
  parseBuildArtifact,
} from "@/modules/publishing/application/commands/build-book";

function fixture() {
  const bookId = 7;
  const jobId = createOpaqueId("job");
  const importId = createOpaqueId("import");
  const versionId = createOpaqueId("version");
  const command = {
    reuse: null,
    bookId,
    capturedCurrentVersionId: null,
    compilerIdentity: "compiler-v8",
    inputRelativePath: `staging/${jobId}/input/book.json`,
    documentSha256: "a".repeat(64),
    sourceUpdatedAt: 3000,
    jobId,
    kind: "build_book",
    previewIdentity: "draft-preview-v8",
    readerIdentity: "mirawind-reader-v5-tailwind-4.3.3",
    rendererIdentity: "semantic-html-v8-katex-0.18.1",
    importId,
    resourceRootRelativePath: `books/${bookId}`,
    versionId,
  } as const;
  const artifact = {
    artifactRootRelativePath: `books/${bookId}/builds/${versionId}`,
    blockingDiagnosticCount: 0,
    compilerIdentity: command.compilerIdentity,
    diagnosticCount: 4,
    kind: "book_build_artifact",
    manifestSha256: "a".repeat(64),
    pageCount: 500,
    previewIdentity: command.previewIdentity,
    readerIdentity: command.readerIdentity,
    rendererIdentity: command.rendererIdentity,
    resourceCount: 120,
    searchRowCount: 12_000,
    semanticDigest: "b".repeat(64),
    versionId,
    versionMarkerSha256: "c".repeat(64),
  } as const;
  return { artifact, command };
}

describe("build candidate protocol values", () => {
  it("accepts one closed command bound to the captured book revision", () => {
    const { command } = fixture();

    expect(parseBuildBookCommand(command)).toEqual(command);
    expect(() =>
      parseBuildBookCommand({ ...command, markdown: "private body" }),
    ).toThrow("BUILD_COMMAND_INVALID");
    expect(() =>
      parseBuildBookCommand({
        ...command,
        resourceRootRelativePath: "../../escape",
      }),
    ).toThrow("BUILD_COMMAND_INVALID");
  });

  it("accepts one bounded artifact and rejects unknown or mismatched output", () => {
    const { artifact, command } = fixture();
    const parsedCommand = parseBuildBookCommand(command);

    expect(parseBuildArtifact(artifact, parsedCommand)).toEqual(artifact);
    for (const invalid of [
      { ...artifact, html: "<main>private</main>" },
      { ...artifact, pageCount: Number.POSITIVE_INFINITY },
      { ...artifact, blockingDiagnosticCount: 5 },
      { ...artifact, versionId: createOpaqueId("version") },
      { ...artifact, compilerIdentity: "invalid-compiler" },
      { ...artifact, artifactRootRelativePath: "../../escape" },
    ]) {
      expect(() => parseBuildArtifact(invalid, parsedCommand)).toThrow(
        "BUILD_ARTIFACT_INVALID",
      );
    }
  });
});
