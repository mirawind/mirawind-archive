import {
  parseBuildArtifact,
  type BuildBookCommand,
  type BuildArtifact,
} from "./build-book";

export interface BuildRegistrationPort<Result> {
  register(input: {
    readonly artifact: BuildArtifact;
    readonly command: BuildBookCommand;
    readonly leaseOwner: string;
    readonly nowMs: number;
  }): Promise<Result>;
}

export async function finalizeBuild<Result>(input: {
  readonly artifact: unknown;
  readonly command: BuildBookCommand;
  readonly leaseOwner: string;
  readonly nowMs: number;
  readonly registration: BuildRegistrationPort<Result>;
}): Promise<Result> {
  const artifact = parseBuildArtifact(input.artifact, input.command);
  return input.registration.register({
    artifact,
    command: input.command,
    leaseOwner: input.leaseOwner,
    nowMs: input.nowMs,
  });
}
