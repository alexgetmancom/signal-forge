/**
 * What retention would free on production, measured, before it is believed.
 *
 * Every size claim this repository has made was proved by hand: copy the database, run the sweep,
 * diff the numbers, throw the script away. Four of those were written in one session -- the
 * snapshot age budget, the per-source body budget, the metric fold, the zstd round trip -- all the
 * same shape, none of them left in the repository, so each number survived only as a sentence in a
 * commit message. "The sweep frees 17 MB" is not a thing anyone can check a week later.
 *
 * This is that measurement as a rehearsal phase. It runs the working tree's sweeps against a
 * writable copy of production and reports, per sweep, how many rows changed and how many bytes the
 * file stopped needing. The copy is destroyed afterwards; nothing here touches production, and the
 * sweeps are the real ones from `src/storage/retention.ts` rather than a reimplementation, which is
 * the only version of this worth running.
 *
 * Freed bytes are counted as freelist growth, not as a smaller file. A delete inside SQLite returns
 * pages to the freelist and leaves the file the same size; `compact-storage` in the stopped phase of
 * a deploy is what hands them back to the filesystem. So "freed" here means "reusable", which is
 * the honest word and the one that explains why the file does not shrink the day a sweep ships.
 *
 * The fingerprint is over the rows affected per sweep, so the ledger can say that a change moved
 * what retention does -- or, more often, that it did not.
 *
 * Usage: bun scripts/rehearse-retention.ts <path/to/app.db> [--result <file>]
 * Reads production only to copy it. Writes to the copy.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldCodeMetricDays } from "../src/runtime/metricFold.js";
import { foldCollectionDays } from "../src/storage/collectionDays.js";
import { repackStoredPayloads } from "../src/storage/repack.js";
import {
  expireSnapshotBodies,
  pruneFailureEvidence,
  pruneOperatorJournal,
  pruneReleaseRenders,
  pruneSnapshots,
  pruneSourceCollectionMetrics,
  pruneSourceShapes,
} from "../src/storage/retention.js";

const source = Bun.argv[2];
if (!source) {
  process.stderr.write(
    "usage: bun scripts/rehearse-retention.ts <path/to/app.db>\n" +
      "Retention is measured against production's own rows. `bun run rehearse --only retention` copies them;\n" +
      "./data/app.db is a stale copy and sweeping it proves nothing, so there is no default.\n",
  );
  process.exit(2);
}
const resultAt = Bun.argv.indexOf("--result");
const resultPath = resultAt >= 0 ? Bun.argv[resultAt + 1] : undefined;

/**
 * The sweeps, each with the table it is about.
 *
 * In the order the service runs them, because they are not independent: the metric fold turns an
 * old day's hours into one row and the prune then decides what to delete, and folding after
 * pruning would fold what is left of a day half gone. See src/index.ts.
 */
const SWEEPS: readonly { name: string; run: (db: Database) => number }[] = [
  { name: "fold metric days", run: (db) => foldCodeMetricDays(db) },
  { name: "expire snapshot bodies", run: (db) => expireSnapshotBodies(db) },
  { name: "prune snapshots", run: (db) => pruneSnapshots(db) },
  { name: "fold collection days", run: (db) => foldCollectionDays(db) },
  { name: "prune raw collection attempts", run: (db) => pruneSourceCollectionMetrics(db) },
  { name: "prune failure evidence", run: (db) => pruneFailureEvidence(db) },
  { name: "prune operator journal", run: (db) => pruneOperatorJournal(db) },
  { name: "prune source shapes", run: (db) => pruneSourceShapes(db) },
  { name: "prune release renders", run: (db) => pruneReleaseRenders(db) },
  {
    name: "repack gzip bodies",
    run: (db) => {
      const result = repackStoredPayloads(db);
      return result.snapshots + result.cacheEntries;
    },
  },
];

/** Pages in the file, and pages nobody needs. The difference is what a sweep actually bought. */
function pages(db: Database): { total: number; free: number; size: number } {
  return {
    total: db.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0,
    free: db.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()?.freelist_count ?? 0,
    size: db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 4096,
  };
}

const workspace = mkdtempSync(join(tmpdir(), "signal-forge-retention-"));
const copy = join(workspace, "app.db");

try {
  copyFileSync(source, copy);
  // Read-write for the same reason the migration rehearsal is: a copy made by `VACUUM INTO` is not
  // in WAL mode, and two live connections to one deadlock. One connection does all of it.
  const db = new Database(copy, { create: false, strict: true });
  db.exec("PRAGMA foreign_keys=ON;");

  const opening = pages(db);
  const swept: { sweep: string; rows: number; freedBytes: number; ms: number }[] = [];
  let previous = opening;
  for (const sweep of SWEEPS) {
    const started = Bun.nanoseconds();
    const rows = sweep.run(db);
    const ms = Math.round((Bun.nanoseconds() - started) / 1e5) / 10;
    const now = pages(db);
    swept.push({
      sweep: sweep.name,
      rows,
      // Pages added to the freelist, minus any the file grew by: a fold writes a day's row before
      // it deletes the day's hours, and charging it only for the deletion would overstate it.
      freedBytes: (now.free - previous.free - (now.total - previous.total)) * now.size,
      ms,
    });
    previous = now;
  }
  const closing = pages(db);
  const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check;
  db.close();

  const freedBytes = (closing.free - opening.free) * closing.size;
  const rows = swept.reduce((total, sweep) => total + sweep.rows, 0);
  const report = {
    source,
    fileBytes: closing.total * closing.size,
    freePagesBefore: opening.free,
    freePagesAfter: closing.free,
    // What `compact-storage` would hand back to the filesystem in the stopped phase of a deploy.
    reusableBytes: closing.free * closing.size,
    freedBytes,
    rowsAffected: rows,
    integrity: integrity ?? "unknown",
    sweeps: swept,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(
    `${rows} rows swept, ${(freedBytes / 1024 ** 2).toFixed(1)} MB made reusable inside a ${(report.fileBytes / 1024 ** 2).toFixed(1)} MB file. ` +
      `A deploy's compact-storage returns ${(report.reusableBytes / 1024 ** 2).toFixed(1)} MB to the filesystem.\n`,
  );
  if (resultPath)
    writeFileSync(
      resultPath,
      JSON.stringify({
        phase: "retention",
        // "moved" is about the change, not about the sweep: retention always removes rows, so a
        // run that removed some is not news. The fingerprint is what a later run compares against.
        verdict: integrity === "ok" ? "same" : "failed",
        moved: rows,
        fingerprint: new Bun.CryptoHasher("sha256")
          .update(JSON.stringify(swept.map((sweep) => [sweep.sweep, sweep.rows])))
          .digest("hex"),
      }),
    );
  process.exit(integrity === "ok" ? 0 : 1);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
