import type Database from "better-sqlite3";
import {
  saveDocument,
  requestPreviewBuild,
} from "@/modules/publishing/adapters/sqlite/save-document";
import { DocumentRepository } from "@/modules/publishing/adapters/sqlite/documents";
import { DraftArtifactReader } from "@/modules/publishing/adapters/filesystem/draft-artifacts";
import { uploadDraftCover } from "@/modules/publishing/adapters/filesystem/draft-cover";
import { BuildRepository } from "@/modules/publishing/adapters/sqlite/builds";
import { DraftRepository } from "@/modules/publishing/adapters/sqlite/drafts";
import { ResourceRepository } from "@/modules/publishing/adapters/sqlite/resources";
import type { StorageLayout } from "@/platform/filesystem/storage-layout";
export function createPublishingDraftServer(database: Database.Database) {
  const drafts = new DraftRepository(database),
    builds = new BuildRepository(database),
    documents = new DocumentRepository(database);
  return Object.freeze({
    findBook: drafts.findBook.bind(drafts),
    requireBook: drafts.requireBook.bind(drafts),
    findCurrentBuild: builds.findCurrent.bind(builds),
    findPreviewBuild: builds.findReadable.bind(builds),
    readDraftView: documents.view.bind(documents),
    readDraftTimestamp: documents.timestamp.bind(documents),
    getDraftBlock: documents.block.bind(documents),
    listDraftImages: (bookId: number) =>
      new ResourceRepository(database).listImages(bookId),
    findDraftImage: (bookId: number, resourceId: string) =>
      new ResourceRepository(database).listImages(bookId, resourceId)[0],
  });
}
export function createPublishingArtifactServer(layout: StorageLayout) {
  return new DraftArtifactReader(layout);
}
export const publishingDraftActions = Object.freeze({
  requestPreviewBuild,
  saveDocument,
  uploadDraftCover,
});
