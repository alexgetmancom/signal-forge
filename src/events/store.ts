import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { Destination } from "../config.js";
import { storeSnapshot } from "../storage/snapshots.js";
import { canonical } from "./canonical.js";
import { classify } from "./classify.js";
import { confidenceFor, evidenceTypeFor } from "./confidence.js";
import { isRoutine } from "./interpretation.js";
import type { SignalClass } from "./signals.js";
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

/**
 * A board position is not a property of the model standing in it.
 *
 * A rank moves whenever anyone above moves, so one model passing another moves every model below
 * it and one real change arrives as a change per row: designarena produced 704 change events in
 * eleven days and not one of them carried a score or a metric that had moved. This is the same
 * reason `rankLower` and `rankUpper` were kept out of the metrics sweep in sources/arena.ts.
 *
 * The top of the board is the exception, because it is the only part anything downstream speaks
 * about: `isMinorBoardMove` passes a change that puts something first or takes it off the top, the
 * scouts' morning names big climbs into the top ten, and dithering is read off ranks that keep
 * returning to a place they held. Those all live inside ten. Records are collected down to
 * `RANKED_PLACES`, twenty, and the half of the board below ten is cascade and nothing else: of
 * designarena's 865 change events, 428 never involved a place inside the top ten.
 */
const SIGNIFICANT_PLACES = 10;

function comparable(record: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...record };
  delete copy.sampledAt;
  delete copy.votes;
  const place = numeric(copy.rank);
  if (place !== null && place > SIGNIFICANT_PLACES) delete copy.rank;
  return copy;
}

/**
 * Fields that move on every poll and never made a card. Measured on production 2026-09-22 over a
 * week: 332 of 375 Polymarket changes were liquidity alone, 700 of 771 on the Hugging Face router
 * were the list of providers serving a model, 194 of 352 on models.dev its provider count. Each kept
 * its snapshot from being pruned, and the market pages alone held 52 MB. The record still takes the
 * new value; only the event is not written.
 */
const RESTLESS_FIELDS: Readonly<Record<string, readonly string[]>> = {
  markets: ["liquidityUsd"],
  "api-models": ["providers", "providerCount", "created"],
};

function comparisonBody(stream: string, body: string): string {
  const restless = RESTLESS_FIELDS[stream];
  if (stream !== "leaderboards" && !restless) return body;
  try {
    const record = JSON.parse(body) as Record<string, unknown>;
    if (stream === "leaderboards") return canonical(comparable(record));
    return canonical(Object.fromEntries(Object.entries(record).filter(([key]) => !restless?.includes(key))));
  } catch {
    return body;
  }
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * How far a number may drift before the drift is the news rather than the measurement.
 *
 * A board that publishes a confidence interval says this itself and is believed. A board that
 * publishes none was being compared exactly, because the width fell back to the score and the
 * overlap test became equality: voxelbench and the artificial-analysis boards produced 2688 change
 * events in eleven days, every one of them a score and nothing else. A quarter of a per cent is
 * narrower than any move those boards have ever reported as meaningful.
 */
const IMPLIED_INTERVAL = 0.0025;

function interval(record: Record<string, unknown>): { lower: number; upper: number } | null {
  const score = numeric(record.score);
  if (score === null) return null;
  const lower = numeric(record.scoreLower);
  const upper = numeric(record.scoreUpper);
  if (lower !== null && upper !== null) return { lower, upper };
  const width = Math.abs(score) * IMPLIED_INTERVAL;
  return { lower: score - width, upper: score + width };
}

/**
 * True while every metric the board reports is where it was, within its own width.
 *
 * `metrics` holds whatever numbers the board publishes beside the rating, swept up by name in
 * sources/arena.ts. They drift exactly as the rating does, and comparing them exactly defeated the
 * overlap test beside them: 740 of the arena's 812 change events had a rating whose interval had
 * not moved and a metric that had, in the last digit.
 */
function metricsSettled(previous: Record<string, unknown>, current: Record<string, unknown>): boolean {
  const before = previous.metrics;
  const after = current.metrics;
  const isMetrics = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isMetrics(before) || !isMetrics(after)) return canonical(before) === canonical(after);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = numeric(before[key]);
    const now = numeric(after[key]);
    if (was === null || now === null) {
      if (canonical(before[key]) !== canonical(after[key])) return false;
      continue;
    }
    if (Math.abs(now - was) > Math.abs(was) * IMPLIED_INTERVAL) return false;
  }
  return true;
}

function leaderboardChange(before: string, after: string): boolean {
  if (comparisonBody("leaderboards", before) === comparisonBody("leaderboards", after)) return false;
  try {
    const previous = JSON.parse(before) as Record<string, unknown>;
    const current = JSON.parse(after) as Record<string, unknown>;
    const besideTheNumbers = (record: Record<string, unknown>): string => {
      const copy = comparable(record);
      for (const key of ["score", "scoreUpper", "scoreLower", "metrics"]) delete copy[key];
      return canonical(copy);
    };
    const previousInterval = interval(previous);
    const currentInterval = interval(current);
    const intervalsOverlap =
      previousInterval !== null &&
      currentInterval !== null &&
      previousInterval.lower <= currentInterval.upper &&
      currentInterval.lower <= previousInterval.upper;
    if (
      intervalsOverlap &&
      metricsSettled(previous, current) &&
      besideTheNumbers(previous) === besideTheNumbers(current)
    )
      return false;
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
  // The registry declares authority and the poller carries it; a collection without one claims the least.
  const authority = c.authority ?? "third_party";
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
  // The boards a scoreboard already had. A board appearing is one fact, not ten debuts: Arena opened
  // image-to-code on 2026-09-13 with fifty models on it, seven of them in a top ten nobody had
  // entered, because there was no board to enter before.
  const boardsBefore =
    c.stream === "leaderboards"
      ? new Set(old.map((row) => (JSON.parse(row.body) as { category?: unknown }).category))
      : null;
  const onANewBoard = (event: Event) =>
    boardsBefore !== null &&
    event.kind === "new" &&
    !boardsBefore.has((JSON.parse(event.after_json ?? "{}") as { category?: unknown }).category);
  // A section the collector stopped reading on purpose is not a catalogue that shrank. On 2026-09-16
  // dropping OpenAI's `index` and Claude Docs' translations left 116 of 788 and 643 of 3,415 records,
  // and the guard below refused both sites until a migration deleted the rows by hand.
  if (c.forget)
    for (const id of [...previous.keys()])
      if (c.forget(id)) {
        db.query("DELETE FROM records WHERE source=? AND id=?").run(c.source, id);
        previous.delete(id);
      }
  if (c.keepMissing) for (const id of [...previous.keys()]) if (c.keepMissing(id)) previous.delete(id);
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
          // The record was seen, so it is not missing: an unconfirmed change still resets the misses,
          // or a record that returns changed between two misses is reported gone while present.
          db.query("UPDATE records SET candidate_body=?,missing_count=0,observed_at=? WHERE source=? AND id=?").run(
            comparableBody,
            now,
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
  // Every record is saved by now, so a rule asking what the catalogues list sees this collection too.
  for (const event of emitted) {
    event.signal = classify(db, event);
    db.query("UPDATE events SET signal=? WHERE id=?").run(event.signal, event.id);
  }
  for (const digest of [false, true]) {
    const events = emitted.filter((event) => isRoutine(event) === digest && !onANewBoard(event));
    // A small company whose model took off here is followed from then on: its next arrival at a
    // reseller is a sighting on arrival, not a line in tomorrow's recap.
    const routed = (event: Event): SignalClass =>
      (event.signal as SignalClass | null | undefined) ?? classify(db, event);
    const present = new Set(events.map(routed));
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
        routed(event),
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
    "INSERT INTO sources(id,last_success,checked_at,authority,vendor) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_success=excluded.last_success,checked_at=excluded.checked_at,last_error=NULL,authority=excluded.authority,vendor=excluded.vendor",
  ).run(c.source, now, now, authority, c.vendor ?? null);
  db.query(
    "DELETE FROM snapshots WHERE source=? AND id NOT IN (SELECT snapshot_id FROM events) AND id NOT IN (SELECT id FROM snapshots WHERE source=? ORDER BY id DESC LIMIT 2)",
  ).run(c.source, c.source);
  return count;
}
