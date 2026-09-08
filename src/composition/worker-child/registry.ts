import {
  analyzeImportHandler,
  buildBookHandler,
  prepareDraftHandler,
} from "./handlers/publishing";
import { purgeBookHandler } from "./handlers/purge-book";
import type { WorkerChildContext, WorkerChildOutcome } from "./job-handler";
import {
  dispatchJobCommand,
  type JobCommandRegistry,
} from "@/entrypoints/worker/job-registry";
import type { FrozenJobInput } from "@/entrypoints/worker/protocol";

export function executeWorkerChildCommand(
  command: FrozenJobInput,
  context: WorkerChildContext,
): Promise<WorkerChildOutcome> {
  const registry = {
    analyze_import: (input) => analyzeImportHandler(input, context),
    build_book: (input) => buildBookHandler(input, context),
    prepare_draft: (input) => prepareDraftHandler(input, context),
    purge_book: (input) => purgeBookHandler(input, context),
  } satisfies JobCommandRegistry<Promise<WorkerChildOutcome>>;
  return Promise.resolve(dispatchJobCommand(command, registry));
}
