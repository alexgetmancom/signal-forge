import type { Database } from "bun:sqlite";
import { CONFIDENCE_LEVELS } from "./events/confidence.js";
import {
  identityFor,
  identityTerms,
  type ModelIdentity,
  mergeIdentities,
  normalizeIdentity,
} from "./events/identity.js";
import { vendorOf } from "./events/interpretation.js";
import type { Confidence, Event, EvidenceType, RecordData } from "./events/types.js";

const CORRELATION_WINDOW_MS = 30 * 24 * 3_600_000;

type StoryEvent = Event & { confidence: Confidence };
type StoryEvidenceRow = StoryEvent & { url: string | null; evidence_type: EvidenceType };
type StoryGroup = {
  baseKey: string;
  subject: string;
  vendor: string;
  events: StoryEvent[];
  identity: ModelIdentity;
  terms: Set<string>;
};

function recordFor(event: Event): RecordData | null {
  const raw = event.after_json ?? event.before_json;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RecordData;
  } catch {
    return null;
  }
}

function normalized(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function subjectFor(event: Event, record: RecordData | null): string {
  if (event.source.startsWith("github:")) {
    // A repository is a useful scope, not a semantic subject. Keep each commit, pull request,
    // and release on its own key unless a future source provides an explicit relation.
    return normalized(`${event.source}:${event.entity_id}`);
  }
  const explicit = [record?.model, record?.id, event.entity_id].find((value) => typeof value === "string" && value);
  return normalized(explicit ?? record?.name ?? event.entity_id) || `event ${event.id}`;
}

function baseKeyFor(event: Event, record: RecordData | null): { key: string; subject: string; vendor: string } {
  const identity = identityFor(event, record);
  const subject = identity.canonicalId ? normalizeIdentity(identity.canonicalId) : subjectFor(event, record);
  const vendor = vendorOf(event, record);
  return { key: `${normalized(vendor)}:${subject}`, subject, vendor };
}

function groupEvents(events: StoryEvent[]): StoryGroup[] {
  const groups: StoryGroup[] = [];
  const current = new Map<string, StoryGroup>();
  const aliases = new Map<string, StoryGroup>();
  for (const event of events) {
    const record = recordFor(event);
    const identity = identityFor(event, record);
    // GitHub records carry repository scope but no model identity. Their display names are not
    // evidence that two independent repository events describe the same subject.
    const terms = event.source.startsWith("github:") ? [] : identityTerms(identity);
    const { key, subject, vendor } = baseKeyFor(event, record);
    const previous =
      terms.map((term) => aliases.get(`${normalized(vendor)}:${term}`)).find((group) => group !== undefined) ??
      current.get(key);
    const last = previous?.events.at(-1);
    if (!previous || !last || Date.parse(event.detected_at) - Date.parse(last.detected_at) > CORRELATION_WINDOW_MS) {
      const group = { baseKey: key, subject, vendor, events: [event], identity, terms: new Set(terms) };
      groups.push(group);
      current.set(key, group);
      for (const term of terms) aliases.set(`${normalized(vendor)}:${term}`, group);
      continue;
    }
    previous.events.push(event);
    previous.identity = mergeIdentities(previous.identity, identity);
    for (const term of terms) {
      previous.terms.add(term);
      aliases.set(`${normalized(vendor)}:${term}`, previous);
    }
  }
  return groups;
}

function storyKey(group: StoryGroup): string {
  return `${group.baseKey}:${group.events[0]?.id ?? "empty"}`;
}

function storyTitle(group: StoryGroup): string {
  const last = group.events.at(-1);
  const record = last ? recordFor(last) : null;
  return String(record?.name ?? record?.model ?? group.subject);
}

/** Rebuilds only the derived story projection; event evidence is never rewritten. The caller owns the transaction. */
export function rebuildStories(db: Database): void {
  const events = db
    .query<StoryEvent, []>(
      "SELECT id,source,stream,entity_id,kind,before_json,after_json,detected_at,confidence,evidence_type FROM events ORDER BY detected_at,id",
    )
    .all();
  const groups = groupEvents(events);
  db.exec("DELETE FROM story_events");
  const existing = db.query<{ id: number; stable_key: string }, []>("SELECT id,stable_key FROM stories").all();
  const keys = new Set(groups.map(storyKey));
  for (const row of existing) if (!keys.has(row.stable_key)) db.query("DELETE FROM stories WHERE id=?").run(row.id);
  for (const group of groups) {
    const first = group.events[0];
    const last = group.events.at(-1);
    if (!first || !last) continue;
    // This is the confidence of the current story update. Individual evidence keeps its own
    // confidence, so a later shipped event cannot upgrade unrelated earlier evidence.
    const confidence = last.confidence;
    const stableKey = storyKey(group);
    const status = last.kind === "removed" ? "removed" : "active";
    const story = db
      .query<{ id: number }, [string, string, string, string, string, string, string, string]>(
        `INSERT INTO stories(stable_key,title,normalized_subject,vendor,first_seen_at,updated_at,confidence,current_status)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(stable_key) DO UPDATE SET title=excluded.title,normalized_subject=excluded.normalized_subject,
           vendor=excluded.vendor,first_seen_at=excluded.first_seen_at,updated_at=excluded.updated_at,
           confidence=excluded.confidence,current_status=excluded.current_status
         RETURNING id`,
      )
      .get(
        stableKey,
        storyTitle(group),
        group.subject,
        group.vendor,
        first.detected_at,
        last.detected_at,
        confidence,
        status,
      );
    if (!story) throw new Error(`Story ${stableKey} could not be stored`);
    for (const event of group.events)
      db.query("INSERT INTO story_events(story_id,event_id) VALUES(?,?)").run(story.id, event.id);
  }
}

export type StoryView = {
  id: string;
  title: string;
  vendor: string;
  canonicalId: string | null;
  identityStatus: ModelIdentity["status"];
  aliases: string[];
  firstSeenAt: string;
  updatedAt: string;
  confidence: Confidence;
  currentStatus: "active" | "removed";
  sources: string[];
  eventIds: number[];
  evidence: {
    eventId: number;
    source: string;
    kind: Event["kind"];
    confidence: Confidence;
    evidenceType: EvidenceType;
    canonicalId: string | null;
    identityStatus: ModelIdentity["status"];
    aliases: string[];
    detectedAt: string;
    url: string | null;
  }[];
};

export type StoryQuery = {
  since?: string | undefined;
  minConfidence?: Confidence;
  vendor?: string | undefined;
  limit?: number;
};

/** Returns a compact agent-facing story view with event IDs that lead back to immutable evidence. */
export function listStories(db: Database, query: StoryQuery = {}): StoryView[] {
  const minRank = CONFIDENCE_LEVELS.indexOf(query.minConfidence ?? "observed");
  const rows = db
    .query<
      {
        id: number;
        stable_key: string;
        title: string;
        vendor: string;
        first_seen_at: string;
        updated_at: string;
        confidence: Confidence;
        current_status: "active" | "removed";
      },
      []
    >(
      "SELECT id,stable_key,title,vendor,first_seen_at,updated_at,confidence,current_status FROM stories ORDER BY updated_at DESC",
    )
    .all()
    .filter((row) => CONFIDENCE_LEVELS.indexOf(row.confidence) >= minRank)
    .filter((row) => !query.since || row.updated_at >= query.since)
    .filter((row) => !query.vendor || row.vendor.toLowerCase() === query.vendor.toLowerCase())
    .slice(0, query.limit ?? 50);
  return rows.map((row) => {
    const evidence = db
      .query<StoryEvidenceRow, [number]>(
        "SELECT e.id,e.source,e.stream,e.entity_id,e.kind,e.before_json,e.after_json,e.detected_at,e.confidence,e.evidence_type,MIN(be.url) AS url FROM story_events se JOIN events e ON e.id=se.event_id LEFT JOIN batch_events be ON be.event_id=e.id WHERE se.story_id=? GROUP BY e.id ORDER BY e.detected_at,e.id",
      )
      .all(row.id)
      .map((event) => {
        const identity = identityFor(event, recordFor(event));
        return {
          eventId: event.id,
          source: event.source,
          kind: event.kind,
          confidence: event.confidence,
          evidenceType: event.evidence_type,
          canonicalId: identity.canonicalId,
          identityStatus: identity.status,
          aliases: identity.aliases,
          detectedAt: event.detected_at,
          url: event.url,
        };
      });
    const identity = evidence.reduce<ModelIdentity>(
      (merged, event) =>
        mergeIdentities(merged, {
          canonicalId: event.canonicalId,
          displayName: row.title,
          aliases: event.aliases,
          status: event.identityStatus,
        }),
      { canonicalId: null, displayName: row.title, aliases: [], status: "unknown" },
    );
    return {
      id: row.stable_key,
      title: row.title,
      vendor: row.vendor,
      canonicalId: identity.canonicalId,
      identityStatus: identity.status,
      aliases: identity.aliases,
      firstSeenAt: row.first_seen_at,
      updatedAt: row.updated_at,
      confidence: row.confidence,
      currentStatus: row.current_status,
      sources: [...new Set(evidence.map((event) => event.source))],
      eventIds: evidence.map((event) => event.eventId),
      evidence,
    };
  });
}
