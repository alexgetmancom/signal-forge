import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runMigrations } from "./migrationRunner.js";

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  // WAL already makes the durability question "is the last commit lost on a host crash", not "is
  // the database intact": a torn write cannot corrupt it either way, because recovery replays the
  // log. FULL additionally fsyncs on every commit, and this service commits constantly -- a poll
  // cycle is hundreds of small transactions. What NORMAL trades away is the last few commits in a
  // machine-level crash, and every one of them is a collection that the next poll repeats anyway,
  // because what is collected is a snapshot of an upstream that is still there to be asked again.
  db.exec("PRAGMA synchronous=NORMAL;");
  // 64 MB of page cache and a 256 MB memory map. The database is 681 MB and the hot tables are a
  // small fraction of it; the default two megabytes of cache means the same index pages are read
  // from the filesystem on every poll.
  db.exec("PRAGMA cache_size=-64000; PRAGMA mmap_size=268435456;");
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
