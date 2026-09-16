import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { Destination } from "../config.js";
import { storeSnapshot } from "../storage/snapshots.js";
import { canonical } from "./canonical.js";
import { authorityForSource, confidenceFor, evidenceTypeFor } from "./confidence.js";
import { isRoutine } from "./interpretation.js";
import { signalClass } from "./signals.js";
import type { Collection, Event } from "./types.js";

export const COLLECTION_DEGRADED_PREFIX = "Collection degraded:";

export class CollectionDegradedError extends Error {
  readonly previousCount: number;
  readonly retainedCount: number;

  constructor(source: string, previousCount: number, retainedCount: number) {
    super(`${COLLECTION_DEGRADED_PREFIX} ${source} retained ${retainedCount} of ${previousCount} records`);
    this.name = "CollectionDegradedError";
    this.previousCount = previousCount;
    this.retainedCount = retainedCount;
  }
}

const normalizedRecord = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
});

const MIN_SUSPICIOUS_SHRINK = 5;

function validateRecords(source: string, records: Collection["records"]): void {
  const ids = new Set<string>();
  records.forEach((record, index) => {
    const result = normalizedRecord.safeParse(record);
    if (!result.success) throw new Error(`${source}: invalid normalized record at index ${index}`);
    if (ids.has(record.id)) throw new Error(`${source}: duplicate record IDs`);
    ids.add(record.id);
  });
}

/**
 * A catalogue that loses a quarter of itself in one answer is a broken answer, not a news day.
 *
 * The bar was half, and the arena went under it by seven rows: on 2026-09-15 it served 871, 872 and
 * then 539 of its 1065 entries, and the next answer had all 1065 back under the same ids. The
 * partial answer was accepted, 193 entries were called gone and 193 came back five minutes later.
 * Measured over every successful collection to 2026-09-16, the arena drops 18 to 38 per cent of its
 * roster for one poll and recovers on the next, dozens of times a week, and no other catalogue
 * whose missing rows mean removal ever lost as much as fifteen per cent in one answer. A rejected
 * answer also resets the consecutive misses a removal needs, so the short answers either side of it
 * cannot finish the job.
 */
function suspiciousShrink(previousCount: number, retainedCount: number): boolean {
  return previousCount - retainedCount >= MIN_SUSPICIOUS_SHRINK && retainedCount * 4 < previousCount * 3;
}

function comparisonBody(stream: string, body: string): string {
  if (stream !== "leaderboards") return body;
  try {
    const record = JSON.parse(body) as Record<string, unknown>;
    delete record.sampledAt;
    delete record.votes;
    return canonical(record);
  } catch {
    return body;
  }
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function interval(record: Record<string, unknown>): { lower: number; upper: number } | null {
  const score = numeric(record.score);
  const lower = numeric(record.scoreLower) ?? score;
  const upper = numeric(record.scoreUpper) ?? score;
  return lower !== null && upper !== null ? { lower, upper } : null;
}

function leaderboardChange(before: string, after: string): boolean {
  if (comparisonBody("leaderboards", before) === comparisonBody("leaderboards", after)) return false;
  try {
    const previous = JSON.parse(before) as Record<string, unknown>;
    const current = JSON.parse(after) as Record<string, unknown>;
    const previousWithoutScore = { ...previous };
    const currentWithoutScore = { ...current };
    for (const key of ["score", "scoreUpper", "scoreLower", "sampledAt", "votes"]) {
      delete previousWithoutScore[key];
      delete currentWithoutScore[key];
    }
    const previousInterval = interval(previous);
    const currentInterval = interval(current);
    const intervalsOverlap =
      previousInterval !== null &&
      currentInterval !== null &&
      previousInterval.lower <= currentInterval.upper &&
      currentInterval.lower <= previousInterval.upper;
    if (intervalsOverlap && canonical(previousWithoutScore) === canonical(currentWithoutScore)) return false;
  } catch {
    return true;
  }
  return true;
}

function recordUrl(body: string | null, fallback: string): string {
  if (!body) return fallback;
  try {
    const record = JSON.parse(body) as Record<string, unknown>;
    return typeof record.url === "string" && record.url.trim() ? record.url : fallback;
  } catch {
    return fallback;
  }
}

function eventUrl(event: Event, fallback: string): string {
  return recordUrl(event.after_json, recordUrl(event.before_json, fallback));
}

const ENDED = /^(?:resolved|closed|complete|unlisted)$/i;

/**
 * An incident that has left the status page has ended as far as anyone can tell, but the vendor did
 * not say so: it stopped publishing. Writing `resolved` there states something the page never
 * stated, and the card then read "identified -> resolved" above the sentence admitting the stage
 * was our inference. `unlisted` is what actually happened, and it is what the reader is told.
 */
function unlistedRecord(body: string): string {
  const record = JSON.parse(body) as Record<string, unknown>;
  if (typeof record.stage === "string" && ENDED.test(record.stage)) return body;
  return canonical({
    ...record,
    stage: "unlisted",
    summary: "Incident no longer listed by the status page.",
  });
}

function hasEnded(body: string): boolean {
  try {
    const record = JSON.parse(body) as Record<string, unknown>;
    return typeof record.stage === "string" && ENDED.test(record.stage);
  } catch {
    return false;
  }
}

/** Persists one validated observation and its immutable evidence in the caller's transaction. */
export function persistCollection(
  db: Database,
  c: Collection,
  destinations: Destination[],
  now = new Date().toISOString(),
): number {
  if (!c.records.length && !c.appendOnly) throw new Error(`${c.source}: empty collection rejected`);
  validateRecords(c.source, c.records);
  const authority = c.authority ?? authorityForSource(c.source);
  const initialized = db.query("SELECT last_success FROM sources WHERE id=?").get(c.source) as {
    last_success: string | null;
  } | null;
  const snapshot = storeSnapshot(db, c.source, now, JSON.stringify(c.raw)).id;
  const old = db
    .query<{ id: string; body: string; missing_count: number; candidate_body: string | null }, [string]>(
      "SELECT id,body,missing_count,candidate_body FROM records WHERE source=?",
    )
    .all(c.source);
  const previous = new Map(old.map((row) => [row.id, row]));
  // A section the collector stopped reading on purpose is not a catalogue that shrank. On 2026-09-16
  // dropping OpenAI's `index` and Claude Docs' translations left 116 of 788 and 643 of 3,415 records,
  // and the guard below refused both sites until a migration deleted the rows by hand.
  if (c.forget)
    for (const id of [...previous.keys()])
      if (c.forget(id)) {
        db.query("DELETE FROM records WHERE source=? AND id=?").run(c.source, id);
        previous.delete(id);
      }
  if (!c.appendOnly && initialized?.last_success && suspiciousShrink(previous.size, c.records.length))
    throw new CollectionDegradedError(c.source, previous.size, c.records.length);
  let count = 0;
  const emitted: Event[] = [];
  const emit = (id: string, kind: Event["kind"], before: string | null, after: string | null) => {
    const confidence = confidenceFor(c.source, c.stream, authority);
    const evidence_type = evidenceTypeFor(c.source, c.stream, authority);
    const row = db
      .query<
        { id: number },
        [string, string, string, string, string | null, string | null, string, number, string, string, string]
      >(
        "INSERT INTO events(source,stream,entity_id,kind,before_json,after_json,detected_at,snapshot_id,confidence,evidence_type,authority) VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
      )
      .get(c.source, c.stream, id, kind, before, after, now, snapshot, confidence, evidence_type, authority);
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
      evidence_type,
      authority,
    });
    count++;
  };
  for (const record of c.records) {
    const body = canonical(record);
    const comparableBody = comparisonBody(c.stream, body);
    const before = previous.get(record.id);
    previous.delete(record.id);
    if (initialized?.last_success && !before && !c.silentIds?.includes(record.id)) emit(record.id, "new", null, body);
    else if (
      initialized?.last_success &&
      before &&
      (c.stream === "leaderboards"
        ? leaderboardChange(before.body, body)
        : comparisonBody(c.stream, before.body) !== comparableBody) &&
      (!c.appendOnly || c.trackChanges) &&
      !c.silentIds?.includes(record.id)
    ) {
      // A source that flickers must show the same new body twice before it is believed. The
      // pending body waits on the record it belongs to, and every path below that writes the
      // record clears it.
      if (c.confirmChanges) {
        if (before.candidate_body === comparableBody) emit(record.id, "changed", before.body, body);
        else {
          db.query("UPDATE records SET candidate_body=? WHERE source=? AND id=?").run(
            comparableBody,
            c.source,
            record.id,
          );
          continue;
        }
      } else emit(record.id, "changed", before.body, body);
    }
    db.query(
      "INSERT INTO records(source,id,body,stream,observed_at) VALUES(?,?,?,?,?) ON CONFLICT(source,id) DO UPDATE SET body=excluded.body,stream=excluded.stream,observed_at=excluded.observed_at,missing_count=0,candidate_body=NULL",
    ).run(c.source, record.id, body, c.stream, now);
  }
  if (!c.appendOnly || c.resolveMissing)
    for (const row of previous.values()) {
      if (c.resolveMissing) {
        if (hasEnded(row.body)) {
          db.query("UPDATE records SET stream=?,observed_at=?,missing_count=0 WHERE source=? AND id=?").run(
            c.stream,
            now,
            c.source,
            row.id,
          );
        } else if (row.missing_count >= 1) {
          const after = unlistedRecord(row.body);
          emit(row.id, "changed", row.body, after);
          db.query("UPDATE records SET body=?,stream=?,observed_at=?,missing_count=0 WHERE source=? AND id=?").run(
            after,
            c.stream,
            now,
            c.source,
            row.id,
          );
        } else {
          db.query("UPDATE records SET missing_count=missing_count+1 WHERE source=? AND id=?").run(c.source, row.id);
        }
        continue;
      }
      if (row.missing_count >= 1) {
        emit(row.id, "removed", row.body, null);
        db.query("DELETE FROM records WHERE source=? AND id=?").run(c.source, row.id);
      } else db.query("UPDATE records SET missing_count=missing_count+1 WHERE source=? AND id=?").run(c.source, row.id);
    }
  for (const digest of [false, true]) {
    const events = emitted.filter((event) => isRoutine(event) === digest);
    const present = new Set(events.map((event) => signalClass(event)));
    const targets = destinations.filter((destination) => destination.signals.some((signal) => present.has(signal)));
    if (!events.length || !targets.length) continue;
    const readyAt = digest ? new Date((Math.floor(Date.parse(now) / 3_600_000) + 1) * 3_600_000).toISOString() : now;
    const batchSource = digest ? "story-digest" : c.source;
    const existing = digest
      ? db
          .query<{ id: number }, [string, string]>(
            "SELECT id FROM batches WHERE source=? AND digest=1 AND ready_at=? AND sealed=0",
          )
          .get(batchSource, readyAt)
      : null;
    const batch =
      existing ??
      db
        .query<{ id: number }, [string, number, string]>(
          "INSERT INTO batches(source,digest,ready_at) VALUES(?,?,?) RETURNING id",
        )
        .get(batchSource, Number(digest), readyAt);
    if (!batch) throw new Error("Batch insert failed");
    for (const event of events)
      db.query("INSERT INTO batch_events(batch_id,event_id,url,signal) VALUES(?,?,?,?)").run(
        batch.id,
        event.id,
        eventUrl(event, c.url),
        signalClass(event),
      );
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
