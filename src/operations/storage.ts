import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { storageReport } from "../reports/storage.js";
import { compactStorage } from "../storage/compact.js";
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
        "What the database file is made of: every table and its indexes, payload bytes, the sources behind both, and how fast events grow.",
      startHere: "the database is growing, or the size alert fired, and I need to know what it is made of",
      note:
        "`file.budgetShare` is the first thing to read and the only one that says whether any of " +
        "the rest is a problem: the file against the size alert's budget, as a percentage. It was " +
        "3.4% on 2026-10-03, and the reason it is here is that an afternoon went into planning " +
        "around `snapshots` holding 47% of the file without that number ever being divided -- 47% " +
        "of 3.4% is not a lever. Read it before `tables`, and if it is small then every breakdown " +
        "below is about shape rather than about size. " +
        "`tables` weighs every table in the file, largest first, so the biggest thing in the " +
        "database is the first row rather than something to go looking for. Start there. It is the " +
        "sum of every column of every row -- blobs as compressed and stored -- and `rows` is " +
        "`ANALYZE`'s estimate, null for a table it has not reached. `unaccountedBytes` is the file " +
        "less those and the free pages, and it is two things: indexes, plus the slack between a " +
        "payload and the pages it sits in. On 2026-10-03 that was 10.9 MB of indexes and about 13 " +
        "MB of slack out of 23.9 -- `tables` sums the length of every column, while a b-tree is " +
        "counted in whole pages, so 80.7 MB of snapshot payload occupies an 82.3 MB b-tree. Both " +
        "numbers are right and they are not the same number; that is the whole of the discrepancy, " +
        "and nothing else is hiding in it. Splitting it here would need `dbstat`, which no Bun on " +
        "Linux is built with, so the breakdown is a development command, `index-cost`, run against " +
        "a copy -- it also records the split in `.rehearsal/ledger.json`, so the index total is " +
        "comparable with last week's rather than with memory. The half of that question which " +
        "needs no `dbstat` -- whether anything uses an index at all, and whether two of them " +
        "duplicate each other -- is in the gate as `check-indexes`. It was 46% of " +
        "the file while this report weighed four tables, and what it hid was the second-largest " +
        "table in the database, and later a 14.1 MB index duplicating a key its table could be. " +
        "`events.bySource` says which sources' events weigh the most and what one of " +
        "them averages, which is the breakdown that explains a jump; `snapshots.bySource` " +
        "is where to look before widening retention: it lists the sources holding the most stored " +
        "payload and the share they hold, and a row with `keptRows` far below `rows` is retention " +
        "working -- a source holds at most eight megabytes of bodies, newest first, whatever their " +
        "age, because the two age horizons bound how old a payload may be and nothing bounded how " +
        "many there are. `events.pace` extrapolates the complete days of the window; events are never deleted, " +
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
      summary: "Apply retention, repack gzip bodies as zstd, and return unused database pages to the filesystem.",
      startHere: "cleanup released payloads, and the database file itself needs to shrink",
      note:
        "Runs SQLite VACUUM. Writers wait while the file is rebuilt; run during the stopped-app " +
        "part of deployment for a large database. `releasedBytes` measures the file before and after, " +
        "not payloads removed; `releasedDiskBytes` counts the write-ahead log with it, which is the " +
        "number the filesystem agrees with -- a VACUUM writes the rebuilt database through the log, so " +
        "this truncates it afterwards -- but truncating needs to be the only connection, so on a running " +
        "service `walCheckpoint` comes back `busy`, `releasedDiskBytes` is zero and the log is returned " +
        "by the next restart instead. Applies snapshot, cache and collection-metric retention. " +
        "Successful attempts retain the two calendar days the fold repairs and the latest five " +
        "attempts per source; failures retain fourteen days. `removedCollectionMetrics` counts the " +
        "deleted details; daily statistics remain. A stored body is never reduced to the fields a " +
        "collector happens to read today: it is the evidence an event is traced back to, and the " +
        "metadata around it is what a report not yet written would have to ask. It then " +
        "repacks remaining gzip snapshot and HTTP cache bodies as zstd in small transactions. " +
        "Each round trip is checked byte for byte; snapshot hashes, original sizes and references " +
        "stay unchanged. `repacked` counts those bodies and their compressed bytes before and after; " +
        "an interrupted repack resumes on the next run, and a completed one writes nothing next time.",
      mutates: true,
      agent: false,
      schema: z.object({}),
      cli: {},
      http: { method: "post", path: "/api/storage/compact" },
      handler: () => compactStorage(db),
    },
  };
}
