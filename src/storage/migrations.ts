import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CURRENT_SCHEMA_VERSION = 25;

export type Migration = {
  version: number;
  name: string;
  filename: string;
  sql: string;
};

export function migrationDirectory(): string {
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

export function validateMigrationSequence(migrations: readonly Migration[]): void {
  if (!migrations.length) throw new Error("No migrations found");
  const seen = new Set<number>();
  migrations.forEach((migration, index) => {
    if (seen.has(migration.version)) throw new Error(`Duplicate migration number: ${migration.version}`);
    seen.add(migration.version);
    const expected = index + 1;
    if (migration.version !== expected)
      throw new Error(`Migration sequence has a gap or wrong order: expected ${expected}, got ${migration.version}`);
  });
  const latest = migrations[migrations.length - 1]?.version;
  if (latest !== CURRENT_SCHEMA_VERSION)
    throw new Error(`Migration journal version ${CURRENT_SCHEMA_VERSION} does not match files ${latest}`);
}
