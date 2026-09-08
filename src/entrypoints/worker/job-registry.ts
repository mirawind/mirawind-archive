import type { FrozenJobInput } from "./protocol";

type CommandOf<Kind extends FrozenJobInput["kind"]> = Extract<
  FrozenJobInput,
  { readonly kind: Kind }
>;

export type JobCommandRegistry<Result> = Readonly<{
  [Kind in FrozenJobInput["kind"]]: (
    command: CommandOf<Kind>,
  ) => Promise<Result> | Result;
}>;

export function dispatchJobCommand<Result>(
  command: FrozenJobInput,
  registry: JobCommandRegistry<Result>,
): Promise<Result> | Result {
  switch (command.kind) {
    case "analyze_import":
      return registry.analyze_import(command);
    case "build_book":
      return registry.build_book(command);
    case "prepare_draft":
      return registry.prepare_draft(command);
    case "purge_book":
      return registry.purge_book(command);
  }
}
