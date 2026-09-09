import type { Database } from "bun:sqlite";
import type { Destination } from "../config.js";
import { canonical } from "./canonical.js";
import { confidenceFor } from "./confidence.js";
import { isRoutine } from "./interpretation.js";
import type { Collection, Event } from "./types.js";

/** Persists one validated observation and its immutable evidence in the caller's transaction. */
export function persistCollection(
  db: Database,
  c: Collection,
  destinations: Destination[],
  now = new Date().toISOString(),
): number {
  if (!c.records.length && !c.appendOnly) throw new Error(`${c.source}: empty collection rejected`);
  if (new Set(c.records.map((record) => record.id)).size !== c.records.length)
    throw new Error(`${c.source}: duplicate record IDs`);
  const initialized = db.query("SELECT last_success FROM sources WHERE id=?").get(c.source) as {
    last_success: string | null;
  } | null;
  const raw = JSON.stringify(c.raw);
  const latest = db
    .query<{ id: number; raw_json: string }, [string]>(
      "SELECT id,raw_json FROM snapshots WHERE source=? ORDER BY id DESC LIMIT 1",
    )
    .get(c.source);
  const snapshotRow =
    latest?.raw_json === raw
      ? latest
      : db
          .query<{ id: number }, [string, string, string]>(
            "INSERT INTO snapshots(source,collected_at,raw_json) VALUES(?,?,?) RETURNING id",
          )
          .get(c.source, now, raw);
  if (!snapshotRow) throw new Error("Snapshot insert failed");
  const snapshot = snapshotRow.id;
  const old = db
    .query<{ id: string; body: string; missing_count: number }, [string]>(
      "SELECT id,body,missing_count FROM records WHERE source=?",
    )
    .all(c.source);
  const previous = new Map(old.map((row) => [row.id, row]));
  let count = 0;
  const emitted: Event[] = [];
  const emit = (id: string, kind: Event["kind"], before: string | null, after: string | null) => {
    const confidence = confidenceFor(c.source, c.stream);
    const row = db
      .query<{ id: number }, [string, string, string, string, string | null, string | null, string, number, string]>(
        "INSERT INTO events(source,stream,entity_id,kind,before_json,after_json,detected_at,snapshot_id,confidence) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id",
      )
      .get(c.source, c.stream, id, kind, before, after, now, snapshot, confidence);
    if (!row) throw new Error("Event insert failed");
    emitted.push({
      id: row.id,
      source: c.source,
      stream: c.stream,
      entity_id: id,
      kind,
      before_json: before,
      after_json: after,
      detected_at: now,
      confidence,
    });
    count++;
  };
  for (const record of c.records) {
    const body = canonical(record);
    const before = previous.get(record.id);
    previous.delete(record.id);
    if (initialized?.last_success && !before && !c.silentIds?.includes(record.id)) emit(record.id, "new", null, body);
    else if (
      initialized?.last_success &&
      before &&
      before.body !== body &&
      (!c.appendOnly || c.trackChanges) &&
      !c.silentIds?.includes(record.id)
    ) {
      if (c.confirmChanges) {
        const candidate = db
          .query<{ body: string; observations: number }, [string, string]>(
            "SELECT body,observations FROM change_candidates WHERE source=? AND id=?",
          )
          .get(c.source, record.id);
        if (candidate?.body === body && candidate.observations >= 1) {
          emit(record.id, "changed", before.body, body);
          db.query("DELETE FROM change_candidates WHERE source=? AND id=?").run(c.source, record.id);
        } else {
          db.query(
            "INSERT INTO change_candidates(source,id,body,observations) VALUES(?,?,?,1) ON CONFLICT(source,id) DO UPDATE SET body=excluded.body,observations=1",
          ).run(c.source, record.id, body);
          continue;
        }
      } else emit(record.id, "changed", before.body, body);
    } else db.query("DELETE FROM change_candidates WHERE source=? AND id=?").run(c.source, record.id);
    db.query(
      "INSERT INTO records(source,id,body) VALUES(?,?,?) ON CONFLICT(source,id) DO UPDATE SET body=excluded.body,missing_count=0",
    ).run(c.source, record.id, body);
  }
  if (!c.appendOnly)
    for (const row of previous.values()) {
      if (row.missing_count >= 1) {
        emit(row.id, "removed", row.body, null);
        db.query("DELETE FROM change_candidates WHERE source=? AND id=?").run(c.source, row.id);
        db.query("DELETE FROM records WHERE source=? AND id=?").run(c.source, row.id);
      } else db.query("UPDATE records SET missing_count=missing_count+1 WHERE source=? AND id=?").run(c.source, row.id);
    }
  for (const digest of [false, true]) {
    const events = emitted.filter((event) => isRoutine(event) === digest);
    const targets = destinations.filter((destination) => destination.streams.some((stream) => stream === c.stream));
    if (!events.length || !targets.length) continue;
    const readyAt = digest ? (Math.floor(Date.parse(now) / 3_600_000) + 1) * 3_600_000 : Date.parse(now);
    const existing = digest
      ? db
          .query<{ id: number }, [string, number]>(
            "SELECT id FROM batches WHERE source=? AND digest=1 AND ready_at=? AND sealed=0",
          )
          .get(c.source, readyAt)
      : null;
    const batch =
      existing ??
      db
        .query<{ id: number }, [string, number, number]>(
          "INSERT INTO batches(source,digest,ready_at) VALUES(?,?,?) RETURNING id",
        )
        .get(c.source, Number(digest), readyAt);
    if (!batch) throw new Error("Batch insert failed");
    for (const event of events)
      db.query("INSERT INTO batch_events(batch_id,event_id,url) VALUES(?,?,?)").run(batch.id, event.id, c.url);
    for (const destination of targets)
      db.query("INSERT OR IGNORE INTO batch_targets(batch_id,destination_id,destination_json) VALUES(?,?,?)").run(
        batch.id,
        destination.id,
        JSON.stringify(destination),
      );
  }
  db.query(
    `INSERT INTO source_collection_metrics(
       source,collected_at,success,records_processed,events_created,new_events,changed_events,removed_events
     ) VALUES(?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    c.source,
    now,
    c.records.length,
    emitted.length,
    emitted.filter((event) => event.kind === "new").length,
    emitted.filter((event) => event.kind === "changed").length,
    emitted.filter((event) => event.kind === "removed").length,
  );
  db.query(
    "INSERT INTO sources(id,last_success,checked_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET last_success=excluded.last_success,checked_at=excluded.checked_at,last_error=NULL",
  ).run(c.source, now, now);
  db.query(
    "DELETE FROM snapshots WHERE source=? AND id NOT IN (SELECT snapshot_id FROM events) AND id NOT IN (SELECT id FROM snapshots WHERE source=? ORDER BY id DESC LIMIT 2)",
  ).run(c.source, c.source);
  return count;
}
