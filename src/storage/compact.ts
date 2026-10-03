import type { Database } from "bun:sqlite";
import { foldCollectionDays } from "./collectionDays.js";
import { HttpCache } from "./httpCache.js";
import { type RepackingResult, repackStoredPayloads } from "./repack.js";
import {
  databaseSize,
  expireSnapshotBodies,
  pruneSnapshots,
  pruneSourceCollectionMetrics,
  walBytes,
} from "./retention.js";

export type CompactionResult = {
  beforeBytes: number;
  afterBytes: number;
  releasedBytes: number;
  beforeWalBytes: number | null;
  afterWalBytes: number | null;
  releasedDiskBytes: number;
  /** Whether the log was actually returned, which a live service's other readers can refuse. */
  walCheckpoint: "truncated" | "busy";
  expiredBodies: number;
  removedSnapshots: number;
  removedCacheEntries: number;
  removedCollectionMetrics: number;
  repacked: RepackingResult;
  elapsedMs: number;
};

/**
 * Applies retention, repacks remaining gzip bodies as zstd, and returns unused pages to the filesystem.
 *
 * The checkpoint after the VACUUM is the part that is easy to leave out. VACUUM rebuilds the whole
 * database, and in WAL mode every page of the rebuild is written through the log, so the `-wal`
 * file is left as large as the database it just rebuilt: 258 MB beside a 252 MB file on production
 * on 2026-10-03, which is more disk than the 32 MB the VACUUM had given back. A passive checkpoint
 * copies those pages home but keeps the file at that size to reuse, so TRUNCATE is the only one
 * that returns the space. Measuring the database alone reported a saving while the directory grew.
 *
 * TRUNCATE needs to be the only connection, and on a running service it is not: the poller, the
 * status worker and the HTTP surface each hold one, and the checkpoint comes back `busy` having
 * done nothing. `exec` does not raise that -- it is a row, not an error -- so the first version of
 * this reported success while leaving a 253 MB log. Hence `walCheckpoint`: on a live service expect
 * `busy` and a `releasedDiskBytes` of zero, and the log is returned by the next restart, which
 * closes the last connection. Run this during the stopped-app part of a deployment to have both.
 *
 * The test covers the truncating case only. The busy one cannot be staged in one process: holding
 * the read transaction that causes it also keeps the VACUUM above from finishing, so what is
 * written here about it is the production reading of 2026-10-03 rather than something a test keeps
 * true. `walCheckpoint` is reported so that reading is available without a shell on the host.
 */
export function compactStorage(db: Database): CompactionResult {
  const started = performance.now();
  const beforeBytes = databaseSize(db).bytes;
  const beforeWalBytes = walBytes(db);
  const now = Date.now();
  foldCollectionDays(db, now);
  let removedCollectionMetrics = 0;
  for (;;) {
    const removed = pruneSourceCollectionMetrics(db, now);
    removedCollectionMetrics += removed;
    if (!removed) break;
  }
  const expiredBodies = expireSnapshotBodies(db);
  const removedSnapshots = pruneSnapshots(db);
  const removedCacheEntries = new HttpCache(db).prune();
  const repacked = repackStoredPayloads(db);
  db.exec("VACUUM");
  const checkpoint = db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
  const afterBytes = databaseSize(db).bytes;
  const afterWalBytes = walBytes(db);
  return {
    beforeBytes,
    afterBytes,
    releasedBytes: Math.max(0, beforeBytes - afterBytes),
    beforeWalBytes,
    afterWalBytes,
    releasedDiskBytes: Math.max(0, beforeBytes + (beforeWalBytes ?? 0) - afterBytes - (afterWalBytes ?? 0)),
    walCheckpoint: checkpoint?.busy ? "busy" : "truncated",
    expiredBodies,
    removedSnapshots,
    removedCacheEntries,
    removedCollectionMetrics,
    repacked,
    elapsedMs: Math.round(performance.now() - started),
  };
}
