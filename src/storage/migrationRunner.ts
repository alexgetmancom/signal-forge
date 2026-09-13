import type { Database } from "bun:sqlite";
import { CURRENT_SCHEMA_VERSION, readMigrations } from "./migrations.js";

function schemaVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
}

export function runMigrations(db: Database): void {
  const migrations = readMigrations();
  let version = schemaVersion(db);
  if (version > CURRENT_SCHEMA_VERSION)
    throw new Error(`Database schema version ${version} is newer than ${CURRENT_SCHEMA_VERSION}`);

  for (const migration of migrations.filter((candidate) => candidate.version > version)) {
    db.transaction(() => {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    })();
    version = migration.version;
  }
  if (version !== CURRENT_SCHEMA_VERSION)
    throw new Error(`Database schema stopped at ${version}, expected ${CURRENT_SCHEMA_VERSION}`);
}
