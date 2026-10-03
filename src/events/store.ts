import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { Destination } from "../config.js";
import { collectionDegraded, SourceError, storageFailure } from "../failure.js";
import { foldCollectionDays } from "../storage/collectionDays.js";
import { storeSnapshot } from "../storage/snapshots.js";
import { canonical } from "./canonical.js";
import { comparisonBody, hasMoved } from "./changeDetection.js";
import { classifyEmitted, onNewBoard, routeEmitted } from "./routing.js";
import type { Collection, Confidence, Event, EvidenceType, SourceAuthority } from "./types.js";
import { narrowWebEvidence } from "./web.js";

const normalizedRecord = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
});

const MIN_SUSPICIOUS_SHRINK = 5;

function validateRecords(source: string, records: Collection["records"]): void {
  const ids = new Set<string>();
  records.forEach((record, index) => {
    const result = normalizedRecord.safeParse(record);
    if (!result.success)
      throw new SourceError("schema", `${source}: invalid normalized record at index ${index}`, {
        evidence: { index, fields: result.error.issues.map((issue) => issue.path.join(".")) },
      });
    if (ids.has(record.id)) throw new SourceError("schema", `${source}: duplicate record IDs`, { evidence: { index } });
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

/** Who vouches for a collection and how far; every event it emits carries the same three. */
type Contract = {
  authority: SourceAuthority;
  evidence_type: EvidenceType;
  confidence: Confidence;
};

/** A record as the last collection left it. */
type Stored = { id: string; body: string; missing_count: number; candidate_body: string | null };

type Emit = (id: string, kind: Event["kind"], before: string | null, after: string | null) => void;

/** Writes an event and remembers it, so what was emitted can be classified and routed afterwards. */
function openEmitter(
  db: Database,
  c: Collection,
  now: string,
  snapshot: number,
  contract: Contract,
): { emit: Emit; emitted: Event[] } {
  const { authority, evidence_type, confidence } = contract;
  const emitted: Event[] = [];
  const emit: Emit = (id, kind, given, incoming) => {
    // A web diff keeps the strings that changed, not the table they changed in; see
    // `narrowWebEvidence`. Narrowed here rather than at the readers so that what is stored and what
    // this cycle routes are the same bytes, and a card can never quote evidence the row does not hold.
    const [before, after] =
      c.stream === "web" && kind === "changed" ? narrowWebEvidence(given, incoming) : [given, incoming];
    const row = db
      .query<
        { id: number },
        [string, string, string, string, string | null, string | null, string, number, string, string, string]
      >(
        "INSERT INTO events(source,stream,entity_id,kind,before_json,after_json,detected_at,snapshot_id,confidence,evidence_type,authority) VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
      )
      .get(c.source, c.stream, id, kind, before, after, now, snapshot, confidence, evidence_type, authority);
    if (!row) throw storageFailure("an event");
    emitted.push({
      signal: null,
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
  };
  return { emit, emitted };
}

/**
 * Drops what this collection is not to be measured against, and says whether an operator has
 * accepted a smaller answer. Throws when the answer looks like a broken one instead.
 *
 * `previous` is edited in place: the rows left in it afterwards are the ones a shrink guard and a
 * removal both consider.
 */
function admitAnswer(
  db: Database,
  c: Collection,
  previous: Map<string, Stored>,
  initialized: { last_success: string | null; accept_shrink: number } | null,
): boolean {
  // A section the collector stopped reading on purpose is not a catalogue that shrank. On 2026-09-16
  // dropping OpenAI's `index` and Claude Docs' translations left 116 of 788 and 643 of 3,415 records,
  // and the guard below refused both sites until a migration deleted the rows by hand.
  if (c.forget)
    for (const id of [...previous.keys()])
      if (c.forget(id)) {
        dropRecord(db, c, id);
        previous.delete(id);
      }
  if (c.keepMissing) for (const id of [...previous.keys()]) if (c.keepMissing(id)) previous.delete(id);
  // An operator who accepted a smaller catalogue spends that acceptance here, on this one answer.
  const accepted = Boolean(initialized?.accept_shrink);
  if (accepted) db.query("UPDATE sources SET accept_shrink=0 WHERE id=?").run(c.source);
  if (
    !accepted &&
    !c.churns &&
    !c.appendOnly &&
    initialized?.last_success &&
    suspiciousShrink(previous.size, c.records.length)
  )
    throw collectionDegraded(c.source, previous.size, c.records.length);
  return accepted;
}

function dropRecord(db: Database, c: Collection, id: string): void {
  db.query("DELETE FROM records WHERE source=? AND id=?").run(c.source, id);
}

/** One more collection in which the record was not in the answer. */
function countMiss(db: Database, c: Collection, id: string): void {
  db.query("UPDATE records SET missing_count=missing_count+1 WHERE source=? AND id=?").run(c.source, id);
}

/**
 * Compares every answered record with what was stored, emits what moved, and writes each record that
 * stands. A record is taken out of `previous` as it is met, so what is left in it afterwards is
 * exactly what the answer no longer contains.
 */
function writeRecords(
  db: Database,
  c: Collection,
  previous: Map<string, Stored>,
  established: boolean,
  now: string,
  emit: Emit,
): void {
  const silent = new Set(c.silentIds);
  for (const record of c.records) {
    const body = canonical(record);
    const before = previous.get(record.id);
    previous.delete(record.id);
    if (established && !silent.has(record.id)) {
      if (!before) emit(record.id, "new", null, body);
      else if (hasMoved(c, before.body, body)) {
        // A source that flickers must show the same new body twice before it is believed. The
        // pending body waits on the record it belongs to, and every path below that writes the
        // record clears it.
        if (c.confirmChanges) {
          const pending = comparisonBody(c.stream, body);
          if (before.candidate_body === pending) emit(record.id, "changed", before.body, body);
          else {
            // The record was seen, so it is not missing: an unconfirmed change still resets the misses,
            // or a record that returns changed between two misses is reported gone while present.
            db.query("UPDATE records SET candidate_body=?,missing_count=0,observed_at=? WHERE source=? AND id=?").run(
              pending,
              now,
              c.source,
              record.id,
            );
            continue;
          }
        } else emit(record.id, "changed", before.body, body);
      }
    }
    db.query(
      "INSERT INTO records(source,id,body,stream,observed_at) VALUES(?,?,?,?,?) ON CONFLICT(source,id) DO UPDATE SET body=excluded.body,stream=excluded.stream,observed_at=excluded.observed_at,missing_count=0,candidate_body=NULL",
    ).run(c.source, record.id, body, c.stream, now);
  }
}

/** What happens to the records an answer no longer contains: kept, resolved, counted as missing, or removed. */
function settleDeparted(
  db: Database,
  c: Collection,
  departed: Iterable<Stored>,
  accepted: boolean,
  now: string,
  emit: Emit,
): void {
  for (const row of departed) {
    // What the operator accepted is exactly these rows leaving. Reporting 781 arena entries gone
    // one card at a time is the same answer as refusing the collection, said more loudly, and
    // keeping them would leave the next poll measured against a roster that no longer exists.
    if (accepted) {
      dropRecord(db, c, row.id);
      continue;
    }
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
      } else countMiss(db, c, row.id);
      continue;
    }
    if (row.missing_count >= 1) {
      emit(row.id, "removed", row.body, null);
      dropRecord(db, c, row.id);
    } else countMiss(db, c, row.id);
  }
}

/** What the collection did, as numbers; then the source's own row, and the snapshots nothing points at. */
function recordOutcome(db: Database, c: Collection, emitted: Event[], contract: Contract, now: string): void {
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
  // The day this collection belongs to, recomputed from the rows that now include it: every count
  // of collections is read from the fold, so a report asked a second after this must see it.
  foldCollectionDays(db, Date.parse(now), 1);
  db.query(
    // `first_observed_at` is written once and never moved: it is the instant from which a miss on
    // this source is ours, and a catalogue that hands us ten years of history on its first call is
    // not late by any of it. See migration 062 and `passedOver`.
    "INSERT INTO sources(id,last_success,checked_at,authority,vendor,evidence_type,confidence,first_observed_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_success=excluded.last_success,checked_at=excluded.checked_at,last_error=NULL,authority=excluded.authority,vendor=excluded.vendor,evidence_type=excluded.evidence_type,confidence=excluded.confidence,first_observed_at=COALESCE(sources.first_observed_at,excluded.first_observed_at)",
  ).run(c.source, now, now, contract.authority, c.vendor ?? null, contract.evidence_type, contract.confidence, now);
  db.query(
    "DELETE FROM snapshots WHERE source=? AND id NOT IN (SELECT snapshot_id FROM events) AND id NOT IN (SELECT id FROM snapshots WHERE source=? ORDER BY id DESC LIMIT 2)",
  ).run(c.source, c.source);
}

/** Persists one validated observation and its immutable evidence in the caller's transaction. */
export function persistCollection(
  db: Database,
  c: Collection,
  destinations: Destination[],
  now = new Date().toISOString(),
): number {
  if (!c.records.length && !c.appendOnly) throw new SourceError("empty", `${c.source}: empty collection rejected`);
  validateRecords(c.source, c.records);
  // The registry declares the contract and the poller carries it; a collection without one claims
  // the least: nobody's authority, no evidence type that fits, the bottom of the scale.
  const contract: Contract = {
    authority: c.authority ?? "third_party",
    evidence_type: c.evidence ?? "unknown",
    confidence: c.confidence ?? "observed",
  };
  const initialized = db.query("SELECT last_success,accept_shrink FROM sources WHERE id=?").get(c.source) as {
    last_success: string | null;
    accept_shrink: number;
  } | null;
  const snapshot = storeSnapshot(db, c.source, now, JSON.stringify(c.raw)).id;
  const old = db
    .query<Stored, [string]>("SELECT id,body,missing_count,candidate_body FROM records WHERE source=?")
    .all(c.source);
  const previous = new Map(old.map((row) => [row.id, row]));
  const onANewBoard = onNewBoard(c.stream, old);
  const accepted = admitAnswer(db, c, previous, initialized);
  const { emit, emitted } = openEmitter(db, c, now, snapshot, contract);
  writeRecords(db, c, previous, Boolean(initialized?.last_success), now, emit);
  if (!c.appendOnly || c.resolveMissing) settleDeparted(db, c, previous.values(), accepted, now, emit);
  const classified = classifyEmitted(db, emitted);
  routeEmitted(db, c, destinations, classified, now, onANewBoard);
  recordOutcome(db, c, emitted, contract, now);
  return emitted.length;
}
