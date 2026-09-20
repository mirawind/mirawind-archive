import { readFile } from "node:fs/promises";

import {
  checksumMigration,
  MigrationChecksumError,
  type Migration,
} from "./migrate";

export const databaseBaselineIdentity = "mirawind-block-storage-v2";

const migrationDefinitions = [
  {
    baselineIdentity: databaseBaselineIdentity,
    checksum:
      "52384f5035dfc3a97e142370bd4a9539e8a35b9b8b29c9ce50d35af9af1a03f6",
    file: "0001_clean_slate.sql",
    name: "block_storage_clean_slate",
    version: 1,
  },
] as const;

export async function loadMigrationManifest(): Promise<readonly Migration[]> {
  return Promise.all(
    migrationDefinitions.map(async (definition) => {
      const sql = await readFile(
        new URL(`./migrations/${definition.file}`, import.meta.url),
        "utf8",
      );
      if (checksumMigration(sql) !== definition.checksum) {
        throw new MigrationChecksumError(definition.version);
      }
      return Object.freeze({
        baselineIdentity: definition.baselineIdentity,
        checksum: definition.checksum,
        name: definition.name,
        sql,
        version: definition.version,
      });
    }),
  );
}
