export type BuildTreeCrashPoint =
  "before_fsync" | "after_fsync_before_rename" | "after_rename";

export type BuildTreeCrashPointInjector = (
  point: BuildTreeCrashPoint,
) => Promise<void> | void;

export async function injectBuildTreeCrashPoint(
  injector: BuildTreeCrashPointInjector | undefined,
  point: BuildTreeCrashPoint,
): Promise<void> {
  await injector?.(point);
}
