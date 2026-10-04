import type { Database } from "bun:sqlite";
import { normalizeIdentity } from "../events/identity.js";
import { sourceFamily } from "../events/sourceFamily.js";

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
};

type Row = Omit<TraceEvent, "family" | "batched" | "delivered" | "suppressedBy" | "storyId"> & {
  story_id: number | null;
  batched: number;
  delivered: number;
  reasons: string | null;
};

export function trace(db: Database, query: string, limit: number): Trace {
  const normalized = normalizeIdentity(query);
  // Three spellings of the needle: what was typed, what it normalizes to, and the normalized form
  // with separators back as wildcards, which is what matches `openai/gpt-6-sol` from "GPT-6 Sol".
  const needles = [...new Set([query, normalized, normalized.replace(/ /g, "%")])].map((value) => `%${value}%`);
  const where = needles.map(() => "lower(e.entity_id) LIKE ? OR lower(s.title) LIKE ?").join(" OR ");
  const rows = db
    .query<Row, string[]>(
      `SELECT e.id,e.source,e.stream,e.entity_id,e.kind,e.signal,e.authority,e.detected_at,
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
    authority: row.authority,
    detected_at: row.detected_at,
    storyId: row.story_id,
    batched: Boolean(row.batched),
    delivered: Boolean(row.delivered),
    suppressedBy: row.reasons ? row.reasons.split(",") : [],
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
