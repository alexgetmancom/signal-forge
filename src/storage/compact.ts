import type { Database } from "bun:sqlite";
import { walBytes } from "../reports/storage.js";
import { HttpCache } from "./httpCache.js";
import { databaseSize, expireSnapshotBodies, pruneSnapshots } from "./retention.js";

export type CompactionResult = {
  beforeBytes: number;
  afterBytes: number;
  releasedBytes: number;
  beforeWalBytes: number | null;
  afterWalBytes: number | null;
  releasedDiskBytes: number;
  expiredBodies: number;
  removedSnapshots: number;
  removedCacheEntries: number;
  elapsedMs: number;
};

/**
 * Applies payload retention and returns the pages it freed to the filesystem.
 *
 * The checkpoint after the VACUUM is the part that is easy to leave out. VACUUM rebuilds the whole
 * database, and in WAL mode every page of the rebuild is written through the log, so the `-wal`
 * file is left as large as the database it just rebuilt: 258 MB beside a 252 MB file on production
 * on 2026-10-03, which is more disk than the 32 MB the VACUUM had given back. A passive checkpoint
 * copies those pages home but keeps the file at that size to reuse, so TRUNCATE is the only one
 * that returns the space. Measuring the database alone reported a saving while the directory grew.
 */
export function compactStorage(db: Database): CompactionResult {
  const started = performance.now();
  const beforeBytes = databaseSize(db).bytes;
  const beforeWalBytes = walBytes(db);
  const expiredBodies = expireSnapshotBodies(db);
  const removedSnapshots = pruneSnapshots(db);
  const removedCacheEntries = new HttpCache(db).prune();
  db.exec("VACUUM");
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
}
