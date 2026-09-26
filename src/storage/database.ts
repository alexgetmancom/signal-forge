import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runMigrations } from "./migrationRunner.js";

export function openDatabase(path: string): Database {
  const db = openWithoutMigrating(path);
  runMigrations(db);
  return db;
}

/**
 * The same file with the same pragmas, with the schema left alone.
 *
 * A heavy collector runs in a process of its own (see src/sources/subprocess.ts) against the
 * database the service has already migrated. Two processes deciding the schema version of one file
 * is how a half-applied migration happens, and a child collecting one source has no business
 * having an opinion about it.
 */
export function openWithoutMigrating(path: string): Database {
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
  // 64 MB of page cache, and no memory map. The database is 681 MB and the hot tables are a small
  // fraction of it; the default two megabytes of cache means the same index pages are read from the
  // filesystem on every poll, so the cache stays.
  //
  // The 256 MB map that used to be here was measured on production on 2026-09-26: of a 981 MB RSS,
  // 267 MB was file-backed and 224 MB of that was private-clean pages of this map. Those pages are
  // reclaimable, so they are not what a container near its limit is killed for, but they are
  // counted in `memory.current` and in every number `memory` reports, which is a quarter of the
  // footprint spent on a cache the operating system already keeps. Running HOT_QUERIES 200 times
  // over a copy of production took 2,120 ms with the map and 2,140 ms without it: at this size the
  // map buys no read that `cache_size` and the page cache do not already serve.
  db.exec("PRAGMA cache_size=-64000; PRAGMA mmap_size=0;");
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
