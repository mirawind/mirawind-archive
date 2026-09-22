import { readFile } from "node:fs/promises";

import {
  checksumMigration,
  MigrationChecksumError,
  type Migration,
} from "./migrate";

export const databaseBaselineIdentity = "mirawind-block-storage-v3";

const migrationDefinitions = [
  {
    baselineIdentity: databaseBaselineIdentity,
    checksum:
      "281c5e48d3bbdfa5183b1ed9c03e5b74146b9fba464aa8ffb87250d86155fbd3",
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
