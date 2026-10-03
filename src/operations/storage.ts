import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { storageReport, walBytes } from "../reports/storage.js";
import { HttpCache } from "../storage/httpCache.js";
import { databaseSize, expireSnapshotBodies, pruneSnapshots } from "../storage/retention.js";
import { count, type OperationMap } from "./definition.js";

/**
 * What the database file is made of, in the "health" section beside `memory`.
 *
 * Its own file because the section it belongs to is already as long as the ratchet allows, and
 * because it is the one entry there that is about disk rather than about a running process.
 */
export function storageOperations(db: Database, _config: AppConfig): OperationMap {
  return {
    storage: {
      section: "health",
      summary:
        "What the database file is made of: payload bytes by table, the sources behind the stored payloads, and how fast events grow.",
      startHere: "the database is growing, or the size alert fired, and I need to know what it is made of",
      note:
        "`bodies` is what the large columns weigh, largest first; snapshots and HTTP cache are counted " +
        "as stored, gzipped. `unaccountedBytes` is the file less those and the free pages -- indexes, every " +
        "smaller table and page overhead -- so it is a remainder, not a measurement. `snapshots.bySource` " +
        "is where to look before widening retention: it lists the sources holding the most stored " +
        "payload and the share they hold, and a row with `keptRows` far below `rows` is retention " +
        "working. `events.pace` extrapolates the complete days of the window; events are never deleted, " +
        "so it is the only growth here that has no ceiling, and it is an average rather than a forecast. " +
        "Row counts are `schema`; this is bytes. Cleanup frees pages for reuse inside the file; " +
        "`compact-storage` returns those pages to the filesystem when the file itself needs to shrink.",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(90, 14), top: count(50, 10) }),
      cli: {
        args: [
          { name: "days", optional: true },
          { name: "top", optional: true },
        ],
      },
      http: { method: "get", path: "/api/storage" },
      handler: (input: { days: number; top: number }) => storageReport(db, input),
    },
    compact_storage: {
      section: "host",
      summary: "Apply payload retention and return unused database pages to the filesystem.",
      startHere: "cleanup released payloads, and the database file itself needs to shrink",
      note:
        "Runs SQLite VACUUM. Writers wait while the file is rebuilt; run during the stopped-app " +
        "part of deployment for a large database. `releasedBytes` measures the file before and after, " +
        "not payloads removed; `releasedDiskBytes` counts the write-ahead log with it, which is the " +
        "number the filesystem agrees with -- a VACUUM writes the rebuilt database through the log, so " +
        "this truncates it afterwards. Uses the status worker's snapshot and cache retention before compacting.",
      mutates: true,
      agent: false,
      schema: z.object({}),
      cli: {},
      http: { method: "post", path: "/api/storage/compact" },
      handler: () => {
        const beforeBytes = databaseSize(db).bytes;
        const started = performance.now();
        const expiredBodies = expireSnapshotBodies(db);
        const removedSnapshots = pruneSnapshots(db);
        const removedCacheEntries = new HttpCache(db).prune();
        const beforeWalBytes = walBytes(db);
        db.exec("VACUUM");
        // VACUUM rebuilds the whole database, and in WAL mode every page of it is written through
        // the log, so the `-wal` file is left as large as the file it just rebuilt: 258 MB beside a
        // 252 MB database on 2026-10-03, which is more disk than the 32 MB the VACUUM had given
        // back. A passive checkpoint copies those pages home but keeps the file at that size for
        // reuse, so the only one that returns the disk is TRUNCATE. Measuring the database alone
        // reported a saving while the directory had grown.
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const afterBytes = databaseSize(db).bytes;
        const afterWalBytes = walBytes(db);
        return {
          beforeBytes,
          afterBytes,
          releasedBytes: Math.max(0, beforeBytes - afterBytes),
          beforeWalBytes,
          afterWalBytes,
          releasedDiskBytes: Math.max(0, beforeBytes + (beforeWalBytes ?? 0) - afterBytes - (afterWalBytes ?? 0)),
          expiredBodies,
          removedSnapshots,
          removedCacheEntries,
          elapsedMs: Math.round(performance.now() - started),
        };
      },
    },
  };
}
