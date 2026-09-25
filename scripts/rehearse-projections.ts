/**
 * Whether an incremental Model Facts update produces exactly what a full rebuild would, on the real
 * history rather than on a fixture.
 *
 * Tests over invented data cannot answer this. What makes an incremental projection dangerous is
 * that it is wrong only for evidence shaped in a way nobody thought to invent -- a record that moves
 * between two identities, a conflict whose incumbent depends on the order two sources were read in,
 * a model whose members are spread over four sources and nine months. Production has 11,159 story
 * events and 25,000 records of exactly that, and neither `rehearse` nor the gate looks at derived
 * data, so this is the only place the claim can be checked.
 *
 * Two questions, both against a copy:
 *
 *   1. Idempotence. Rebuild everything, then ask for an incremental update of every source in turn.
 *      Nothing changed between the two, so every row must come back identical. An ordering mistake,
 *      a cross-filter that reads beyond its model, or a member missing from the index all show up
 *      here, because each of them makes the recomputed subset disagree with the whole.
 *   2. Arrival. Hide the newest events, rebuild, then reveal them one collection at a time through
 *      the incremental path, and compare against a full rebuild over everything. This is the case
 *      the service actually runs, and the one where a model gains evidence it did not have.
 *
 * Reads the copy at .rehearsal/prod.db that `rehearse` leaves behind. Never touches production.
 */

import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { rebuildModelFacts, updateModelFacts } from "../src/modelFacts.js";

const root = resolve(import.meta.dir, "..");
const source = resolve(root, ".rehearsal/prod.db");
const working = resolve(root, ".rehearsal/projections.db");
const hideCount = Number(process.argv[2] ?? "40");

if (!existsSync(source)) {
  process.stderr.write("No copy at .rehearsal/prod.db -- run `bun run rehearse` first.\n");
  process.exit(1);
}

function say(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** The three projected tables as one comparable string, in a fixed order. */
function snapshot(db: Database): string {
  const facts = db
    .query<Record<string, unknown>, []>(
      "SELECT canonical_id,canonical_key,first_seen_at,updated_at FROM model_facts ORDER BY canonical_id",
    )
    .all();
  const fields = db
    .query<Record<string, unknown>, []>(
      `SELECT canonical_id,field,value_json,confidence,evidence_type,source,event_id,observed_at
       FROM model_fact_fields ORDER BY canonical_id,field,source,event_id`,
    )
    .all();
  const conflicts = db
    .query<Record<string, unknown>, []>(
      `SELECT canonical_id,field,incumbent_event_id,challenger_event_id,detected_at
       FROM model_fact_conflicts ORDER BY canonical_id,field,incumbent_event_id,challenger_event_id`,
    )
    .all();
  return JSON.stringify({ facts, fields, conflicts });
}

/** The first line on which two snapshots differ, as a sentence rather than two megabytes of JSON. */
function firstDifference(left: string, right: string): string {
  const a = JSON.parse(left) as Record<string, Record<string, unknown>[]>;
  const b = JSON.parse(right) as Record<string, Record<string, unknown>[]>;
  for (const table of ["facts", "fields", "conflicts"]) {
    const rowsA = a[table] ?? [];
    const rowsB = b[table] ?? [];
    if (rowsA.length !== rowsB.length) {
      const extra = rowsA.length > rowsB.length ? rowsA : rowsB;
      const side = rowsA.length > rowsB.length ? "full" : "incremental";
      const missing = extra.filter(
        (row) =>
          !(rowsA.length > rowsB.length ? rowsB : rowsA).some((other) => JSON.stringify(other) === JSON.stringify(row)),
      );
      return `${table}: ${rowsA.length} rows after a full rebuild, ${rowsB.length} after incremental; ${side} has ${JSON.stringify(missing.slice(0, 3))}`;
    }
    for (let index = 0; index < rowsA.length; index++)
      if (JSON.stringify(rowsA[index]) !== JSON.stringify(rowsB[index]))
        return `${table} row ${index}: full ${JSON.stringify(rowsA[index])} vs incremental ${JSON.stringify(rowsB[index])}`;
  }
  return "no difference";
}

function open(): Database {
  const db = new Database(working);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=OFF; PRAGMA cache_size=-64000;");
  return db;
}

/**
 * A consistent copy. `VACUUM INTO` writes a new file from a read transaction rather than copying
 * bytes: copying the main file alongside its `-wal` and `-shm` produced `database disk image is
 * malformed` the first time, because those three are only a database together at a moment nobody
 * was holding still.
 */
function copy(): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${working}${suffix}`, { force: true });
  const from = new Database(source, { readonly: true });
  from.query("VACUUM INTO ?").run(working);
  from.close();
}

say("Copying .rehearsal/prod.db");
copy();
const db = open();

// The schema this build expects, since the copy predates the migration that adds the membership.
const { runMigrations } = await import("../src/storage/migrationRunner.js");
runMigrations(db);

const sources = db
  .query<{ source: string }, []>("SELECT DISTINCT source FROM records ORDER BY source")
  .all()
  .map((row) => row.source);

say(`Full rebuild over ${db.query<{ n: number }, []>("SELECT COUNT(*) n FROM story_events").get()?.n} story events`);
let started = Bun.nanoseconds();
db.transaction(() => rebuildModelFacts(db))();
const fullMs = (Bun.nanoseconds() - started) / 1e6;
const afterFull = snapshot(db);
say(
  `  ${fullMs.toFixed(0)} ms, ${JSON.parse(afterFull).fields.length} fields over ${JSON.parse(afterFull).facts.length} models`,
);

say(`Idempotence: an incremental update of each of ${sources.length} sources must change nothing`);
started = Bun.nanoseconds();
for (const name of sources) {
  const records = db
    .query<{ source: string; id: string }, [string]>("SELECT source,id FROM records WHERE source=?")
    .all(name);
  db.transaction(() => updateModelFacts(db, { storyIds: [], records }))();
}
const idempotentMs = (Bun.nanoseconds() - started) / 1e6;
const afterIdempotent = snapshot(db);
const idempotent = afterIdempotent === afterFull;
say(`  ${idempotentMs.toFixed(0)} ms for all of them, ${(idempotentMs / sources.length).toFixed(1)} ms each`);
say(idempotent ? "  identical" : `  DIFFERS -- ${firstDifference(afterFull, afterIdempotent)}`);

// Arrival: hide the newest events, rebuild, then let them arrive through the incremental path.
//
// The events themselves stay. Thirteen tables carry a foreign key into `events`, so deleting one is
// a different experiment from the one intended; the projection only ever sees an event through
// `story_events`, so removing that link is exactly "this event has not been accounted for yet".
const newest = db
  .query<{ event_id: number; story_id: number; source: string }, [number]>(
    `SELECT se.event_id,se.story_id,e.source FROM story_events se JOIN events e ON e.id=se.event_id
     ORDER BY se.event_id DESC LIMIT ?`,
  )
  .all(hideCount)
  .reverse();
say(`Arrival: unlinking the newest ${newest.length} events, then letting them arrive one at a time`);

db.transaction(() => {
  const unlink = db.query("DELETE FROM story_events WHERE event_id=?");
  for (const row of newest) unlink.run(row.event_id);
  rebuildModelFacts(db);
})();

const insertLink = db.query("INSERT INTO story_events(story_id,event_id) VALUES(?,?)");
started = Bun.nanoseconds();
for (const row of newest) {
  db.transaction(() => {
    insertLink.run(row.story_id, row.event_id);
    const records = db
      .query<{ source: string; id: string }, [string]>("SELECT source,id FROM records WHERE source=?")
      .all(row.source);
    updateModelFacts(db, { storyIds: [row.story_id], records });
  })();
}
const arrivalMs = (Bun.nanoseconds() - started) / 1e6;
const afterArrival = snapshot(db);
const each = arrivalMs / Math.max(newest.length, 1);
say(`  ${newest.length} arrivals in ${arrivalMs.toFixed(0)} ms, ${each.toFixed(1)} ms each`);
const arrivalEqual = afterArrival === afterFull;
say(arrivalEqual ? "  identical to the full rebuild" : `  DIFFERS -- ${firstDifference(afterFull, afterArrival)}`);

say("");
say(`full rebuild        ${fullMs.toFixed(0)} ms`);
say(`incremental, each   ${each.toFixed(1)} ms`);
say(`speedup             ${(fullMs / each).toFixed(0)}x`);
db.close();
process.exit(idempotent && arrivalEqual ? 0 : 1);
