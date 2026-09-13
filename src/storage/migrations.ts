import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CURRENT_SCHEMA_VERSION = 25;

export type Migration = {
  version: number;
  name: string;
  filename: string;
  sql: string;
};

function migrationDirectory(): string {
  return fileURLToPath(new URL("./migrations/", import.meta.url));
}

export function readMigrations(directory = migrationDirectory()): Migration[] {
  const migrations = readdirSync(directory)
    .filter((filename) => filename.endsWith(".sql"))
    .map((filename) => {
      const match = /^(\d{3})_([a-z0-9_]+)\.sql$/.exec(filename);
      if (!match) throw new Error(`Invalid migration filename: ${filename}`);
      return {
        version: Number(match[1]),
        name: match[2] ?? filename,
        filename,
        sql: readFileSync(`${directory}/${filename}`, "utf8"),
      };
    })
    .sort((left, right) => left.version - right.version);
  validateMigrationSequence(migrations);
  return migrations;
}

/**
 * The journal is a baseline file and the migrations that came after it. It does not start at 1:
 * the baseline is numbered for the version it produces, so a database already holding that version
 * has nothing to run, and a new one reaches it in a single step.
 */
export function validateMigrationSequence(migrations: readonly Migration[]): void {
  if (!migrations.length) throw new Error("No migrations found");
  migrations.forEach((migration, index) => {
    const previous = migrations[index - 1];
    if (!previous) return;
    if (migration.version === previous.version) throw new Error(`Duplicate migration number: ${migration.version}`);
    if (migration.version !== previous.version + 1)
      throw new Error(
        `Migration sequence has a gap or wrong order: expected ${previous.version + 1}, got ${migration.version}`,
      );
  });
  const latest = migrations[migrations.length - 1]?.version;
  if (latest !== CURRENT_SCHEMA_VERSION)
    throw new Error(`Migration journal version ${CURRENT_SCHEMA_VERSION} does not match files ${latest}`);
}
