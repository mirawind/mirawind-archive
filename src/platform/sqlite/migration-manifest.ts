import { readFile } from "node:fs/promises";

import {
  checksumMigration,
  MigrationChecksumError,
  type Migration,
} from "./migrate";

export const databaseBaselineIdentity = "mirawind-block-storage-v1";

const migrationDefinitions = [
  {
    baselineIdentity: databaseBaselineIdentity,
    checksum:
      "4017e643526a04e60ff4f2c2a4b43938b0d73feca1667837d5130396f166de4e",
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
