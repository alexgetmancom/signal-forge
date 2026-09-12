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
 * Usage: bun scripts/rehearse-migration.ts [path/to/app.db]
 */
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const before = new Database(copy, { readonly: true, strict: true });
  const startingVersion = before.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  const beforeCounts = counts(before);
  const beforeBodies = fingerprints(before);
  before.close();

  const started = Date.now();
  const db = new Database(copy, { create: false, strict: true });
  db.exec("PRAGMA foreign_keys=ON;");
  runMigrations(db);
  const elapsedMs = Date.now() - started;
  const afterCounts = counts(db);
  const afterBodies = fingerprints(db);
  const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check;
  db.close();

  const changedBodies = [...afterBodies].filter(
    ([key, hash]) => beforeBodies.has(key) && beforeBodies.get(key) !== hash,
  );
  const removedRecords = [...beforeBodies.keys()].filter((key) => !afterBodies.has(key));
  const tableChanges = Object.entries(afterCounts)
    .filter(([table, count]) => (beforeCounts[table] ?? 0) !== count)
    .map(([table, count]) => ({ table, before: beforeCounts[table] ?? 0, after: count }));
  const safe = integrity === "ok" && changedBodies.length === 0 && removedRecords.length === 0;

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
        verdict: safe
          ? "Safe to apply: the schema moved and no stored record body did."
          : "Inspect before applying: stored record bodies moved, rows disappeared, or the copy failed its integrity check.",
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = safe ? 0 : 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
