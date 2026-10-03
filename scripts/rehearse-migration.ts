/**
 * A migration is rehearsed on a copy of the database it will actually run against, because the
 * squashed schema cannot show what production's own rows carry.
 *
 * The failure this is built around is specific to this service: subscriber-facing strings are
 * stored inside `records.body` and compared byte for byte to decide whether something changed.
 * Reword one without migrating the stored rows and the next collection emits a "changed" event for
 * every record carrying it - a channel full of announcements about nothing, none of which can be
 * taken back. So the rehearsal reports what the migration did to those bodies, not only whether it
 * ran.
 *
 * It also reads the plan of every query in src/storage/hotQueries.ts before and after. An index the
 * planner ignores looks exactly like an index that was never created, which is how 049 shipped five
 * of them that did nothing until `ANALYZE` ran; a read that was a SEARCH and comes back a SCAN is
 * reported here rather than discovered in a month of slow collections.
 *
 * And it times them, because the plan is a proxy and the proxy let one through. Migration 075 was
 * first written with `PRIMARY KEY (bucket_start, name)`, copying the lesson of 074 that the day
 * leads the key. Every hot read stayed a SEARCH, so every check in this repository passed it, and
 * the `timings` report went from 191 ms to 6,979 ms -- thirty-four times slower, because a
 * correlated subquery per metric name lost its seek and re-sought the whole range for each one.
 * A plan says which index a read reached for. It does not say what reaching cost.
 *
 * Rehearsed with that key order put back as a throwaway migration on 2026-10-03, against the same
 * copy of production: `planRegressions` was empty -- every step of the plan was still a SEARCH on
 * the primary key -- and the read went from 26.64 ms to 9,639.69 ms. 362x, waved through by the
 * check that existed and caught by the clock.
 *
 * Usage: bun scripts/rehearse-migration.ts [path/to/app.db]
 */
import { Database, type Statement } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOT_QUERIES, HOT_WRITES, scansATable } from "../src/storage/hotQueries.js";
import { runMigrations } from "../src/storage/migrationRunner.js";
import { CURRENT_SCHEMA_VERSION } from "../src/storage/migrations.js";

// No default. The one this had was `./data/app.db`, the stale copy AGENTS.md says never to answer
// from, and run without an argument this script rehearsed against a schema eighteen versions behind
// production and failed with "older than the baseline" -- a sentence about nothing. `rehearse` hands
// it the fresh copy; by hand, `bun run rehearse --only migration` is the way to get one.
const source = Bun.argv[2];
if (!source) {
  process.stderr.write(
    "usage: bun scripts/rehearse-migration.ts <path/to/app.db>\n" +
      "A migration is rehearsed against production's own rows. `bun run rehearse --only migration` copies them;\n" +
      "./data/app.db is a stale copy and rehearsing against it proves nothing, so there is no default.\n",
  );
  process.exit(2);
}
const workspace = mkdtempSync(join(tmpdir(), "signal-forge-rehearsal-"));
const copy = join(workspace, "app.db");

function fingerprints(db: Database): Map<string, string> {
  return new Map(
    db
      .query<{ source: string; id: string; body: string }, []>("SELECT source,id,body FROM records")
      .all()
      .map((row): [string, string] => [`${row.source} ${row.id}`, Bun.hash(row.body).toString(16)]),
  );
}

/**
 * Every statement whose plan and cost are checked: the hot reads, and the hot writes beside them.
 *
 * Writes are named `write: <name>` so the two cannot collide and so a moved line says which list
 * it came from. They are measured the same way with one difference, `mutates`, which puts the run
 * inside a transaction that is rolled back -- see `timings`.
 */
type Measured = { name: string; sql: string; params: readonly (string | number | null)[]; mutates: boolean };

const MEASURED: readonly Measured[] = [
  ...HOT_QUERIES.map((query) => ({ name: query.name, sql: query.sql, params: query.params, mutates: false })),
  ...HOT_WRITES.map((write) => ({ name: `write: ${write.name}`, sql: write.sql, params: write.params, mutates: true })),
];

/**
 * The plan of each hot read, as one line per query.
 *
 * A query naming a table the copy does not have yet is expected before the migration runs, and is
 * recorded as such rather than skipped: "this read had no plan because the table did not exist" is
 * the honest before-state of a migration that creates it.
 */
function plans(db: Database): Map<string, string> {
  return new Map(
    MEASURED.map((query): [string, string] => {
      // Prepared rather than `query`, and finalized whatever happens. A statement this connection
      // owns and nobody finalized holds the file open: the close below then cannot take effect and
      // the migration fails as SQLITE_BUSY, with nothing in the message about a plan or a hot read.
      // `prepare` itself is what throws for a table the migration has not created yet, so it is
      // inside the `try` -- outside it, there is no statement to finalize and the lock stays.
      // Migration 074 is the first to add a table a hot read names.
      let statement: Statement<{ detail: string }, (string | number | null)[]> | null = null;
      try {
        statement = db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`);
        return [
          query.name,
          statement
            .all(...query.params)
            .map((row) => row.detail)
            .join(" | "),
        ];
      } catch (error) {
        return [query.name, `unavailable: ${error instanceof Error ? error.message : "unknown"}`];
      } finally {
        statement?.finalize();
      }
    }),
  );
}

/**
 * How long each hot read takes, as the best of three runs.
 *
 * Best rather than mean: the question is what the read costs when nothing else is in the way, and
 * the slow runs here are the page cache filling and this machine doing something else. A floor is
 * the stable number; an average of a cold run and two warm ones is a number that moves on its own.
 *
 * Rows are counted and dropped. Keeping them would measure this script's memory rather than
 * SQLite's work, and two of these reads answer with every row of a table.
 */
function timings(db: Database): Map<string, { ms: number; rows: number } | null> {
  const measured = new Map<string, { ms: number; rows: number } | null>();
  for (const query of MEASURED) {
    let statement: Statement<Record<string, unknown>, (string | number | null)[]> | null = null;
    try {
      statement = db.prepare(query.sql);
      let best = Number.POSITIVE_INFINITY;
      let rows = 0;
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        // A write is run for real and then taken back. Measuring one any other way measures
        // something else: `EXPLAIN` does not touch a page, and a write run outside a transaction
        // would leave the copy's rows a little further from production's with every attempt, so
        // the second attempt would not be timing the same statement as the first.
        if (query.mutates) db.exec("BEGIN");
        const started = Bun.nanoseconds();
        rows = statement.all(...query.params).length;
        best = Math.min(best, (Bun.nanoseconds() - started) / 1e6);
        if (query.mutates) db.exec("ROLLBACK");
      }
      measured.set(query.name, { ms: Math.round(best * 100) / 100, rows });
    } catch {
      // A failed write may have left its transaction open; the next statement would then fail for
      // that reason rather than its own.
      if (query.mutates)
        try {
          db.exec("ROLLBACK");
        } catch {
          /* there was none */
        }
      // The same case `plans` records as unavailable: a read naming a table the migration has not
      // created yet has no cost to compare against, which is not a regression.
      measured.set(query.name, null);
    } finally {
      statement?.finalize();
    }
  }
  return measured;
}

/**
 * What counts as a read getting slower.
 *
 * Both halves are needed. Without the factor, a read that went from 0.1 ms to 1 ms fails the
 * rehearsal for nine tenths of a millisecond. Without the floor, the factor fires on exactly that:
 * timing noise on reads that cost nothing is measured in multiples. The 34x regression this exists
 * to catch cleared both by three orders of magnitude.
 */
const SLOWER_BY = 3;
const SLOWER_THAN_MS = 20;
const ATTEMPTS = 3;

function counts(db: Database): Record<string, number> {
  return Object.fromEntries(
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((table) => [
        table.name,
        db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table.name}`).get()?.count ?? 0,
      ]),
  );
}

try {
  copyFileSync(source, copy);
  // The copy is a throwaway, and a read-only connection to a WAL database cannot create the -shm
  // file it needs, so the reading pass opens it read-write like the migrating one does. One
  // connection does both passes: a second one, opened while the first still held prepared
  // statements, deadlocked against it on any database not in WAL mode -- which is every copy made
  // by `VACUUM INTO`, and so every copy of production this was supposed to be rehearsed against.
  const before = new Database(copy, { create: false, strict: true });
  const startingVersion = before.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  const beforeCounts = counts(before);
  const beforeBodies = fingerprints(before);
  const beforePlans = plans(before);
  const beforeTimings = timings(before);
  // Closed before the migration opens its own, and never open at the same time. Both halves of that
  // matter: two live connections deadlock on a copy made by `VACUUM INTO`, which is not in WAL mode,
  // and a single connection carries the prepared statements of the reading pass into the migrating
  // one -- where a `DROP TABLE` on anything already read answers SQLITE_LOCKED. 068 rebuilds
  // `events` to widen a CHECK, which is the first migration to drop a table this script had read,
  // and it failed here for a reason that had nothing to do with the migration.
  before.close();

  const db = new Database(copy, { create: false, strict: true });
  const started = Date.now();
  db.exec("PRAGMA foreign_keys=ON;");
  runMigrations(db);
  const elapsedMs = Date.now() - started;
  db.close();

  const after = new Database(copy, { create: false, strict: true });
  const afterCounts = counts(after);
  const afterBodies = fingerprints(after);
  const afterPlans = plans(after);
  const afterTimings = timings(after);
  const integrity = after.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check;
  after.close();

  const changedBodies = [...afterBodies].filter(
    ([key, hash]) => beforeBodies.has(key) && beforeBodies.get(key) !== hash,
  );
  const removedRecords = [...beforeBodies.keys()].filter((key) => !afterBodies.has(key));
  const tableChanges = Object.entries(afterCounts)
    .filter(([table, count]) => (beforeCounts[table] ?? 0) !== count)
    .map(([table, count]) => ({ table, before: beforeCounts[table] ?? 0, after: count }));
  const planChanges = [...afterPlans.entries()]
    .filter(([name, plan]) => beforePlans.get(name) !== plan)
    .map(([name, plan]) => ({ name, before: beforePlans.get(name) ?? "unknown", after: plan }));
  // A read that stopped using an index is the regression this exists to catch. A read that started
  // using one is the point of the migration, and is reported without failing it.
  const planRegressions = planChanges.filter(
    (change) => scansATable(change.after) && !scansATable(change.before) && !change.before.startsWith("unavailable"),
  );
  // A read whose cost moved, in either direction: the migration that makes one faster is reported
  // for the same reason a plan that gained an index is, and the one that makes a read slower while
  // keeping its index is the whole reason this is measured and not inferred.
  const timingChanges = [...afterTimings.entries()]
    .map(([name, after]) => ({ name, before: beforeTimings.get(name) ?? null, after }))
    .filter((change) => change.before !== null && change.after !== null && change.before.ms !== change.after.ms)
    .map((change) => ({
      name: change.name,
      beforeMs: (change.before as { ms: number }).ms,
      afterMs: (change.after as { ms: number }).ms,
      factor:
        Math.round(((change.after as { ms: number }).ms / Math.max((change.before as { ms: number }).ms, 0.01)) * 100) /
        100,
      rows: (change.after as { rows: number }).rows,
    }))
    .sort((one, other) => other.factor - one.factor);
  const timingRegressions = timingChanges.filter(
    (change) => change.factor >= SLOWER_BY && change.afterMs - change.beforeMs >= SLOWER_THAN_MS,
  );
  const scanning = [...afterPlans.entries()]
    .filter(([, plan]) => scansATable(plan))
    .map(([name, plan]) => ({ name, plan }));
  const safe =
    integrity === "ok" &&
    changedBodies.length === 0 &&
    removedRecords.length === 0 &&
    planRegressions.length === 0 &&
    timingRegressions.length === 0;

  process.stdout.write(
    `${JSON.stringify(
      {
        source,
        startingVersion,
        finalVersion: CURRENT_SCHEMA_VERSION,
        elapsedMs,
        integrity: integrity ?? "unknown",
        tableChanges,
        // A stored body that moved is the case to stop for: every one of them is a "changed" event.
        recordBodiesChanged: changedBodies.length,
        recordsRemoved: removedRecords.length,
        planChanges,
        planRegressions,
        // The cost of each hot read before and after, best of three. A plan says which index a read
        // reached for; only this says what reaching cost.
        timingChanges,
        timingRegressions,
        // Not a failure: some of these are whole-table reads by design. Printed so that an index
        // shipped without `ANALYZE` is visible instead of silently doing nothing.
        stillScanning: scanning,
        verdict: safe
          ? "Safe to apply: the schema moved and no stored record body did."
          : "Inspect before applying: stored record bodies moved, rows disappeared, a hot read lost its index " +
            `or got ${SLOWER_BY}x slower, or the copy failed its integrity check.`,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = safe ? 0 : 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
