import {
  type BuildBookCommand,
  type BuildArtifact,
  type BuildStageUpdate,
} from "@/modules/publishing/application/publishing-api";
import { jobChildProtocolVersion, type JobProgressMessage } from "../protocol";

export interface CandidateBuildExecutor {
  (input: {
    readonly command: BuildBookCommand;
    readonly onStage: (update: BuildStageUpdate) => void;
    readonly signal?: AbortSignal;
  }): Promise<BuildArtifact>;
}

export async function handleBuildBook(input: {
  readonly command: BuildBookCommand;
  readonly execute: CandidateBuildExecutor;
  readonly onProgress?: (message: JobProgressMessage) => void;
  readonly signal?: AbortSignal;
}): Promise<BuildArtifact> {
  const { command } = input;
  const artifact = await input.execute({
    command,
    onStage(update) {
      input.onProgress?.(
        Object.freeze({
          jobId: command.jobId,
          phase: update.phase,
          progress: Object.freeze({
            completed: update.completed,
            processed_bytes: null,
            total: update.total,
            unit: update.unit,
          }),
          protocolVersion: jobChildProtocolVersion,
          type: "progress",
        }),
      );
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return artifact;
}
