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
  // 16 MB of page cache, not 64. SQLite's cache is anonymous memory -- the kind a container is
  // killed for -- and it caches the same pages the kernel already holds as reclaimable file cache
  // with `mmap_size=0`. Measured 2026-09-27 on a copy of production: HOT_QUERIES 200 times took
  // 2,254 ms at 16 MB against 2,263 at 64, so the 48 MB bought no read; at 8 MB it took 2,813 and
  // the cache started missing. The ceiling is what matters rather than the steady state, because a
  // process that once filled 64 MB of cache never gives the mark back, and each heavy collector
  // runs in a child that would have paid the same ceiling for one collection.
  db.exec("PRAGMA cache_size=-16000; PRAGMA mmap_size=0;");
  return db;
}

/**
 * The same database, opened to be read while the app is writing to it.
 *
 * A bare `new Database(path, {readonly: true})` carries no busy timeout, so a reader that happens to
 * arrive during a write is refused with SQLITE_BUSY instead of waiting the moment out. Scripts that
 * only look are the ones this matters to: they run against the live file by definition.
 *
 * `strict` is here for a worse reason than the timeout. Without it a named parameter -- `.all({
 * since })` -- binds nothing and the statement answers zero rows, where the writing connection,
 * which has always been `strict`, answers correctly. A report read one way in the service and
 * another way under `probe` and `rehearse`, and the reading that was wrong was the silent one.
 */
export function readonlyDatabase(path: string): Database {
  const db = new Database(path, { readonly: true, strict: true });
  db.exec("PRAGMA busy_timeout=5000;");
  return db;
}
