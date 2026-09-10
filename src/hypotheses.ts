import type { Database } from "bun:sqlite";
import { CONFIDENCE_LEVELS } from "./events/confidence.js";
import { sourceIndependenceFamily } from "./events/sourceFamily.js";
import type { Confidence, Event, EvidenceType } from "./events/types.js";

export type HypothesisStatus = "emerging" | "strengthening" | "confirmed" | "stale";

export type HypothesisEvent = {
  eventId: number;
  role: "supporting" | "resolution";
  source: string;
  confidence: Confidence;
  evidenceType: EvidenceType;
  detectedAt: string;
};

export type HypothesisView = {
  id: number;
  stableKey: string;
  storyId: number;
  storyStableKey: string;
  storyTitle: string;
  subject: string;
  status: HypothesisStatus;
  independentSourceCount: number;
  firstSeenAt: string;
  formedAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolutionEventId: number | null;
  events: HypothesisEvent[];
};

export type HypothesesQuery = { status?: HypothesisStatus | undefined; limit?: number | undefined };

type TimelineEvent = Event & { confidence: Confidence; evidence_type: EvidenceType; story_id: number };
type StoryTimeline = {
  storyId: number;
  stableKey: string;
  title: string;
  firstSeenAt: string;
  events: TimelineEvent[];
};

function confidenceRank(value: Confidence): number {
  return CONFIDENCE_LEVELS.indexOf(value);
}

function timelines(db: Database): StoryTimeline[] {
  const rows = db
    .query<
      TimelineEvent & {
        stable_key: string;
        title: string;
        first_seen_at: string;
      },
      []
    >(
      `SELECT s.id AS story_id,s.stable_key,s.title,s.first_seen_at,
              e.id,e.source,e.stream,e.entity_id,e.kind,e.before_json,e.after_json,e.detected_at,
              e.confidence,e.evidence_type
       FROM stories s
       JOIN story_events se ON se.story_id=s.id
       JOIN events e ON e.id=se.event_id
       ORDER BY s.id,e.detected_at,e.id`,
    )
    .all();
  const grouped = new Map<number, StoryTimeline>();
  for (const row of rows) {
    const story = grouped.get(row.story_id) ?? {
      storyId: row.story_id,
      stableKey: row.stable_key,
      title: row.title,
      firstSeenAt: row.first_seen_at,
      events: [],
    };
    story.events.push(row);
    grouped.set(row.story_id, story);
  }
  return [...grouped.values()];
}

function hypothesisFor(
  story: StoryTimeline,
  now: number,
): {
  stableKey: string;
  storyId: number;
  subject: string;
  status: HypothesisStatus;
  independentSourceCount: number;
  firstSeenAt: string;
  formedAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolutionEventId: number | null;
  supporting: TimelineEvent[];
  resolution: TimelineEvent | null;
} | null {
  const firstConfirmedIndex = story.events.findIndex(
    (event) => confidenceRank(event.confidence) >= confidenceRank("confirmed"),
  );
  const beforeConfirmation = firstConfirmedIndex < 0 ? story.events : story.events.slice(0, firstConfirmedIndex);
  const families = new Set<string>();
  let formed: TimelineEvent | null = null;
  for (const event of beforeConfirmation) {
    families.add(sourceIndependenceFamily(event.source, event.stream));
    if (families.size >= 2 && !formed) formed = event;
  }
  if (!formed || families.size < 2) return null;
  const resolution = firstConfirmedIndex < 0 ? null : (story.events[firstConfirmedIndex] ?? null);
  const lastEvidence = story.events.at(-1);
  const unresolvedOld =
    resolution === null &&
    lastEvidence !== undefined &&
    Number.isFinite(Date.parse(lastEvidence.detected_at)) &&
    now - Date.parse(lastEvidence.detected_at) >= 14 * 24 * 3_600_000;
  const status: HypothesisStatus = resolution
    ? "confirmed"
    : unresolvedOld
      ? "stale"
      : families.size >= 3
        ? "strengthening"
        : "emerging";
  return {
    stableKey: `story:${story.stableKey}`,
    storyId: story.storyId,
    subject: `Unconfirmed activity around ${story.title}`,
    status,
    independentSourceCount: families.size,
    firstSeenAt: story.firstSeenAt,
    formedAt: formed.detected_at,
    updatedAt: lastEvidence?.detected_at ?? story.firstSeenAt,
    resolvedAt: resolution?.detected_at ?? null,
    resolutionEventId: resolution?.id ?? null,
    supporting: beforeConfirmation,
    resolution,
  };
}

/** Rebuilds hypotheses from stories and immutable event timelines; the caller owns the transaction. */
export function rebuildHypotheses(db: Database, now = Date.now()): void {
  const existing = new Set(
    db
      .query<{ stable_key: string }, []>("SELECT stable_key FROM hypotheses")
      .all()
      .map((row) => row.stable_key),
  );
  const current = new Set<string>();
  for (const story of timelines(db)) {
    const hypothesis = hypothesisFor(story, now);
    if (!hypothesis) continue;
    current.add(hypothesis.stableKey);
    const row = db
      .query<
        { id: number },
        [string, number, string, HypothesisStatus, number, string, string, string, string | null, number | null]
      >(
        `INSERT INTO hypotheses(
           stable_key,story_id,subject,status,independent_source_count,first_seen_at,formed_at,updated_at,resolved_at,resolution_event_id
         ) VALUES(?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(stable_key) DO UPDATE SET story_id=excluded.story_id,subject=excluded.subject,status=excluded.status,
           independent_source_count=excluded.independent_source_count,first_seen_at=excluded.first_seen_at,
           formed_at=excluded.formed_at,updated_at=excluded.updated_at,resolved_at=excluded.resolved_at,
           resolution_event_id=excluded.resolution_event_id
         RETURNING id`,
      )
      .get(
        hypothesis.stableKey,
        hypothesis.storyId,
        hypothesis.subject,
        hypothesis.status,
        hypothesis.independentSourceCount,
        hypothesis.firstSeenAt,
        hypothesis.formedAt,
        hypothesis.updatedAt,
        hypothesis.resolvedAt,
        hypothesis.resolutionEventId,
      );
    if (!row) throw new Error(`Hypothesis ${hypothesis.stableKey} could not be stored`);
    db.query("DELETE FROM hypothesis_events WHERE hypothesis_id=?").run(row.id);
    for (const event of hypothesis.supporting)
      db.query("INSERT INTO hypothesis_events(hypothesis_id,event_id,role) VALUES(?,?,?)").run(
        row.id,
        event.id,
        "supporting",
      );
    if (hypothesis.resolution)
      db.query("INSERT INTO hypothesis_events(hypothesis_id,event_id,role) VALUES(?,?,?)").run(
        row.id,
        hypothesis.resolution.id,
        "resolution",
      );
  }
  for (const stableKey of existing)
    if (!current.has(stableKey)) db.query("DELETE FROM hypotheses WHERE stable_key=?").run(stableKey);
}

function readView(
  db: Database,
  row: {
    id: number;
    stable_key: string;
    story_id: number;
    subject: string;
    status: HypothesisStatus;
    independent_source_count: number;
    first_seen_at: string;
    formed_at: string;
    updated_at: string;
    resolved_at: string | null;
    resolution_event_id: number | null;
  },
): HypothesisView {
  const story = db
    .query<{ stable_key: string; title: string }, [number]>("SELECT stable_key,title FROM stories WHERE id=?")
    .get(row.story_id);
  const events = db
    .query<
      HypothesisEvent & {
        event_id: number;
        source: string;
        confidence: Confidence;
        evidence_type: EvidenceType;
        detected_at: string;
      },
      [number]
    >(
      `SELECT he.event_id,he.role,e.source,e.confidence,e.evidence_type,e.detected_at
       FROM hypothesis_events he JOIN events e ON e.id=he.event_id
       WHERE he.hypothesis_id=? ORDER BY e.detected_at,e.id`,
    )
    .all(row.id)
    .map((event) => ({
      eventId: event.event_id,
      role: event.role,
      source: event.source,
      confidence: event.confidence,
      evidenceType: event.evidence_type,
      detectedAt: event.detected_at,
    }));
  return {
    id: row.id,
    stableKey: row.stable_key,
    storyId: row.story_id,
    storyStableKey: story?.stable_key ?? "",
    storyTitle: story?.title ?? "",
    subject: row.subject,
    status: row.status,
    independentSourceCount: row.independent_source_count,
    firstSeenAt: row.first_seen_at,
    formedAt: row.formed_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    resolutionEventId: row.resolution_event_id,
    events,
  };
}

type HypothesisRow = Parameters<typeof readView>[1];

export function listHypotheses(db: Database, query: HypothesesQuery = {}): HypothesisView[] {
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Hypothesis limit must be between 1 and 100");
  const rows = db
    .query<HypothesisRow, []>(
      "SELECT id,stable_key,story_id,subject,status,independent_source_count,first_seen_at,formed_at,updated_at,resolved_at,resolution_event_id FROM hypotheses ORDER BY updated_at DESC,id",
    )
    .all()
    .filter((row) => !query.status || row.status === query.status)
    .slice(0, limit);
  return rows.map((row) => readView(db, row));
}

export function getHypothesis(db: Database, id: number): HypothesisView | null {
  if (!Number.isInteger(id) || id < 1) throw new Error("Hypothesis ID must be positive");
  const row = db
    .query<HypothesisRow, [number]>(
      "SELECT id,stable_key,story_id,subject,status,independent_source_count,first_seen_at,formed_at,updated_at,resolved_at,resolution_event_id FROM hypotheses WHERE id=?",
    )
    .get(id);
  return row ? readView(db, row) : null;
}
