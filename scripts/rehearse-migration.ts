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
 * Usage: bun scripts/rehearse-migration.ts [path/to/app.db]
 */
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOT_QUERIES, scansATable } from "../src/storage/hotQueries.js";
import { runMigrations } from "../src/storage/migrationRunner.js";
import { CURRENT_SCHEMA_VERSION } from "../src/storage/migrations.js";

const source = Bun.argv[2] ?? "./data/app.db";
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
 * The plan of each hot read, as one line per query.
 *
 * A query naming a table the copy does not have yet is expected before the migration runs, and is
 * recorded as such rather than skipped: "this read had no plan because the table did not exist" is
 * the honest before-state of a migration that creates it.
 */
function plans(db: Database): Map<string, string> {
  return new Map(
    HOT_QUERIES.map((query): [string, string] => {
      try {
        const rows = db
          .query<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${query.sql}`)
          .all(...query.params);
        return [query.name, rows.map((row) => row.detail).join(" | ")];
      } catch (error) {
        return [query.name, `unavailable: ${error instanceof Error ? error.message : "unknown"}`];
      }
    }),
  );
}

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
  // file it needs, so the reading pass opens it read-write like the migrating one does.
  const before = new Database(copy, { create: false, strict: true });
  const startingVersion = before.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  const beforeCounts = counts(before);
  const beforeBodies = fingerprints(before);
  const beforePlans = plans(before);
  before.close();

  const started = Date.now();
  const db = new Database(copy, { create: false, strict: true });
  db.exec("PRAGMA foreign_keys=ON;");
  runMigrations(db);
  const elapsedMs = Date.now() - started;
  const afterCounts = counts(db);
  const afterBodies = fingerprints(db);
  const afterPlans = plans(db);
  const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check;
  db.close();

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
  const scanning = [...afterPlans.entries()]
    .filter(([, plan]) => scansATable(plan))
    .map(([name, plan]) => ({ name, plan }));
  const safe =
    integrity === "ok" && changedBodies.length === 0 && removedRecords.length === 0 && planRegressions.length === 0;

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
        // Not a failure: some of these are whole-table reads by design. Printed so that an index
        // shipped without `ANALYZE` is visible instead of silently doing nothing.
        stillScanning: scanning,
        verdict: safe
          ? "Safe to apply: the schema moved and no stored record body did."
          : "Inspect before applying: stored record bodies moved, rows disappeared, a hot read lost its index, or the copy failed its integrity check.",
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = safe ? 0 : 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
