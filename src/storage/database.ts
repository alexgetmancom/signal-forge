import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runMigrations } from "./migrationRunner.js";

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  runMigrations(db);
  return db;
}

/**
 * The same database, opened to be read while the app is writing to it.
 *
 * A bare `new Database(path, {readonly: true})` carries no busy timeout, so a reader that happens to
 * arrive during a write is refused with SQLITE_BUSY instead of waiting the moment out. Scripts that
 * only look are the ones this matters to: they run against the live file by definition.
 */
export function readonlyDatabase(path: string): Database {
  const db = new Database(path, { readonly: true });
  db.exec("PRAGMA busy_timeout=5000;");
  return db;
}
