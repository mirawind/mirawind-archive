import type Database from "better-sqlite3";

import { BookPresentationRepository } from "@/modules/catalog/adapters/sqlite/book-presentations";

import {
  reconcileBookVersionPresentations,
  type PresentationReconciliation,
} from "@/modules/publishing/adapters/filesystem/book-presentation";
import { reconcilePublishingStorage } from "@/modules/publishing/adapters/filesystem/storage-reconciliation";
import {
  verifyAndRecoverCurrentVersions,
  type CurrentVersionRecovery,
} from "./version-verification";
import type { StorageLayout } from "@/platform/filesystem/storage-layout";

export interface StorageReconciliation {
  readonly corruptDatabaseVersions: readonly string[];
  readonly presentationReconciliation: PresentationReconciliation;
  readonly quarantinedDirectories: readonly string[];
  readonly recoveredCurrentVersions: readonly CurrentVersionRecovery[];
  readonly removedOrphanPaths: readonly string[];
  readonly removedStagingDirectories: readonly string[];
}

export async function reconcileStorage(input: {
  readonly database: Database.Database;
  readonly layout: StorageLayout;
  readonly nowMs: number;
}): Promise<StorageReconciliation> {
  const publishing = await reconcilePublishingStorage(input);
  const presentationReconciliation = await reconcileBookVersionPresentations({
    ...input,
    presentations: new BookPresentationRepository(input.database),
  });
  const recoveredCurrentVersions = await verifyAndRecoverCurrentVersions({
    ...input,
    presentationIntegrityFailures: [
      ...presentationReconciliation.failedVersionIds,
      ...presentationReconciliation.mismatchedVersionIds,
    ],
  });
  return Object.freeze({
    corruptDatabaseVersions: publishing.corruptDatabaseVersions,
    presentationReconciliation,
    quarantinedDirectories: publishing.quarantinedDirectories,
    recoveredCurrentVersions,
    removedOrphanPaths: publishing.removedOrphanPaths,
    removedStagingDirectories: publishing.removedStagingDirectories,
  });
}
