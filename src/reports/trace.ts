import type { Database } from "bun:sqlite";
import { normalizeIdentity } from "../events/identity.js";
import { sourceFamily } from "../events/sourceFamily.js";
import type { Event } from "../events/types.js";
import { arrivalRejection } from "../recap/arrivals.js";

/**
 * Every sighting of one name, in order, with what each one did.
 *
 * This is the question the deployment is actually asked. `usage` on 2026-10-04 had `sql` at 837 of
 * 2309 calls, and the two largest shapes nothing covered were both `events`: 77 hand-written reads
 * of the table and 49 aggregates of it, against `coveredBy: null`. The example it kept is a name
 * hunt -- four `entity_id LIKE` clauses over thirty days -- written by hand because no command
 * takes a name.
 *
 * `model` takes one, and cannot answer here: it resolves a canonical id out of `model_facts`, so it
 * returns null for exactly the subjects an investigation is about. `unbiased/pareto-26.10-preview`
 * and `apodex/apodex-1.1-mini` both had stories, events and a card sent about them on 2026-10-04,
 * and `model` said null for both because neither was ever identified. The commands covered the
 * models already known and every question started with one that was not.
 *
 * So the match is deliberately loose -- the normalized name, and the raw text, against the event's
 * entity id and its story's title -- because the caller has a string off a card and not a key. The
 * answer is ordered by time rather than grouped by source, because the thing being reconstructed is
 * always a sequence: who said it first, who repeated it, when it spoke.
 */
export type Trace = {
  query: string;
  normalized: string;
  stories: TraceStory[];
  /**
   * The raw rows a collector holds under this name, which is where the sequence starts.
   *
   * An event is a difference, so a name with no event is not a name nothing was collected about:
   * the record can be sitting in `records` from the collection that first held it, or from a source
   * that has since been retired and answers nothing now. Field names and sizes rather than bodies,
   * because what the question needs is whether anything is held and what shape it is; the values
   * are in the events, where they are already evidence.
   */
  records: TraceRecord[];
  events: TraceEvent[];
  /** What the sequence adds up to, so the common question needs no second pass over the table. */
  summary: {
    events: number;
    sources: number;
    /** Unrelated sources, collapsed the way corroboration collapses them. */
    families: string[];
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    delivered: number;
    suppressed: number;
  };
};

type TraceRecord = {
  source: string;
  /**
   * Whether the registry still names this source, so a silence has an explanation beside it.
   *
   * `live_sources` and not `retired_at`: a row is only stamped once a boot has found it missing, and
   * what the question needs is whether anything is still asking, which the view answers.
   */
  stillRegistered: boolean;
  id: string;
  stream: string;
  observedAt: string;
  /** The record's own top-level field names, in the order the body carries them. */
  fields: string[];
  bytes: number;
};

type TraceStory = {
  id: number;
  title: string;
  vendor: string | null;
  confidence: string;
  current_status: string;
  first_seen_at: string;
  released_at: string | null;
};

type TraceEvent = {
  id: number;
  source: string;
  family: string;
  stream: string;
  entity_id: string;
  kind: string;
  signal: string | null;
  authority: string | null;
  detected_at: string;
  storyId: number | null;
  /** Whether a batch was ever built naming this event -- the fact `speaks` is mistaken for. */
  batched: boolean;
  /** Whether a delivery carrying it was accepted. */
  delivered: boolean;
  /** Every rule that held it back, deduplicated across destinations. */
  suppressedBy: string[];
  /**
   * The recap rule that keeps this sighting out of a week's arrivals, or null when none does.
   *
   * A different question from `suppressedBy`, and the one that is otherwise unanswerable without
   * reading `src/recap/arrivals.ts` beside the record: a card is about this event, and an arrival is
   * about what the week is told. Null on an event that would count does not promise a line in the
   * recap -- the period rules above it ask whether anything dated the model to that week, and a
   * period is not what this report is about.
   */
  notAnArrival: string | null;
};

/**
 * The event row as the table holds it, beside what became of it.
 *
 * The whole row and not the columns this report prints, because the arrival rules are asked of it:
 * they read a record body, a stream and a classification, and a projection that happened to carry
 * the printed columns would answer those questions about an event that does not exist.
 */
type Row = Event & {
  story_id: number | null;
  batched: number;
  delivered: number;
  reasons: string | null;
};

/**
 * The raw rows held under this name, whatever any event says.
 *
 * Matched on the record's key and the name inside its body, because a collector's key is not always
 * a name: an arena roster is keyed by UUID. The field names come from SQLite's own `json_each` and
 * the size from `length`, so no body crosses into this process: what the question needs is whether
 * anything is held and what shape it is. `live_sources` answers whether the source still runs, which
 * is the difference between "nothing has come in" and "nothing is being asked".
 */
function tracedRecords(db: Database, needles: readonly string[], limit: number): TraceRecord[] {
  const where = needles.map(() => "lower(r.id) LIKE ? OR lower(json_extract(r.body,'$.name')) LIKE ?").join(" OR ");
  return db
    .query<
      {
        source: string;
        id: string;
        stream: string;
        observed_at: string;
        fields: string | null;
        bytes: number;
        live: number;
      },
      string[]
    >(
      `SELECT r.source,r.id,r.stream,r.observed_at,
              (SELECT group_concat(key) FROM json_each(r.body)) AS fields,
              length(r.body) AS bytes,
              EXISTS(SELECT 1 FROM live_sources l WHERE l.id=r.source) AS live
         FROM records r WHERE ${where} ORDER BY r.observed_at, r.source, r.id LIMIT ${limit}`,
    )
    .all(...needles.flatMap((needle) => [needle, needle]))
    .map((row) => ({
      source: row.source,
      stillRegistered: Boolean(row.live),
      id: row.id,
      stream: row.stream,
      observedAt: row.observed_at,
      fields: row.fields ? row.fields.split(",") : [],
      bytes: row.bytes,
    }));
}

export function trace(db: Database, query: string, limit: number): Trace {
  const normalized = normalizeIdentity(query);
  // Three spellings of the needle: what was typed, what it normalizes to, and the normalized form
  // with separators back as wildcards, which is what matches `openai/gpt-6-sol` from "GPT-6 Sol".
  const needles = [...new Set([query, normalized, normalized.replace(/ /g, "%")])].map((value) => `%${value}%`);
  const where = needles.map(() => "lower(e.entity_id) LIKE ? OR lower(s.title) LIKE ?").join(" OR ");
  const rows = db
    .query<Row, string[]>(
      `SELECT e.id,e.source,e.stream,e.entity_id,e.kind,e.signal,e.authority,e.detected_at,e.after_json,
              se.story_id,
              EXISTS(SELECT 1 FROM batch_events be WHERE be.event_id=e.id) AS batched,
              EXISTS(SELECT 1 FROM batch_events be JOIN deliveries d ON d.batch_id=be.batch_id
                     WHERE be.event_id=e.id AND d.status='sent') AS delivered,
              (SELECT group_concat(DISTINCT sp.reason) FROM suppressions sp WHERE sp.event_id=e.id) AS reasons
         FROM events e
         LEFT JOIN story_events se ON se.event_id=e.id
         LEFT JOIN stories s ON s.id=se.story_id
        WHERE ${where}
        ORDER BY e.detected_at, e.id
        LIMIT ${limit}`,
    )
    .all(...needles.flatMap((needle) => [needle.toLowerCase(), needle.toLowerCase()]));

  const events: TraceEvent[] = rows.map((row) => ({
    id: row.id,
    source: row.source,
    family: sourceFamily(row.source, row.stream),
    stream: row.stream,
    entity_id: row.entity_id,
    kind: row.kind,
    signal: row.signal,
    authority: row.authority ?? null,
    detected_at: row.detected_at,
    storyId: row.story_id,
    batched: Boolean(row.batched),
    delivered: Boolean(row.delivered),
    suppressedBy: row.reasons ? row.reasons.split(",") : [],
    /**
     * Asked of the event as it stands, with nothing renamed: `renamed` is a verdict a recap reaches
     * over a whole period, and this report is about one name rather than one week.
     */
    notAnArrival: arrivalRejection(row, new Set()),
  }));
  const storyIds = [...new Set(events.map((event) => event.storyId).filter((id): id is number => id !== null))];
  const stories = storyIds.length
    ? db
        .query<TraceStory, number[]>(
          `SELECT id,title,vendor,confidence,current_status,first_seen_at,released_at FROM stories
            WHERE id IN (${storyIds.map(() => "?").join(",")}) ORDER BY first_seen_at`,
        )
        .all(...storyIds)
    : [];
  return {
    query,
    normalized,
    stories,
    records: tracedRecords(
      db,
      needles.map((needle) => needle.toLowerCase()),
      limit,
    ),
    events,
    summary: {
      events: events.length,
      sources: new Set(events.map((event) => event.source)).size,
      families: [...new Set(events.map((event) => event.family))].sort(),
      firstSeenAt: events[0]?.detected_at ?? null,
      lastSeenAt: events.at(-1)?.detected_at ?? null,
      delivered: events.filter((event) => event.delivered).length,
      suppressed: events.filter((event) => event.suppressedBy.length).length,
    },
  };
}
