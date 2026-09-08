import type Database from "better-sqlite3";

import { BuildPublicationRepository } from "@/modules/publishing/adapters/sqlite/build-publication";
import {
  m1PublishPolicy,
  publishBuild,
} from "@/modules/publishing/application/publishing-api";

export function createPublicationServer(database: Database.Database) {
  return Object.freeze({
    publishBuild: (input: {
      readonly actorUserId: string | null;
      readonly bookId: number;
      readonly expectedUpdatedAt: number;
      readonly buildId: string;
      readonly nowMs: number;
    }) =>
      publishBuild({
        ...input,
        policy: m1PublishPolicy,
        publication: new BuildPublicationRepository(database),
      }),
  });
}
