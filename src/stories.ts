import type { Database } from "bun:sqlite";
import { authorityForSource, CONFIDENCE_LEVELS, sourceFamily } from "./events/confidence.js";
import {
  identityFor,
  identityTerms,
  type ModelIdentity,
  mergeIdentities,
  normalizeIdentity,
} from "./events/identity.js";
import { vendorOf } from "./events/interpretation.js";
import type { Confidence, Event, EvidenceType, RecordData, SourceAuthority } from "./events/types.js";

const CORRELATION_WINDOW_MS = 30 * 24 * 3_600_000;

type StoryEvent = Event & { authority: SourceAuthority; confidence: Confidence };
type StoryEvidenceRow = StoryEvent & { url: string | null; evidence_type: EvidenceType };
type StoryGroup = {
  baseKey: string;
  subject: string;
  vendor: string;
  firstEventId: number;
  firstDetectedAt: string;
  last: StoryEvent;
  identity: ModelIdentity;
  terms: Set<string>;
  urls: Set<string>;
  titleTerms: Set<string>;
  storyId?: number;
};

export type StoryProjection = {
  groups: StoryGroup[];
  current: Map<string, StoryGroup>;
  aliases: Map<string, StoryGroup>;
  lastEventId: number;
  lastDetectedAt: string | null;
};

const projections = new WeakMap<Database, StoryProjection>();

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

function canonicalUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    for (const key of [...url.searchParams.keys()])
      if (key.toLowerCase().startsWith("utm_") || ["fbclid", "gclid", "ref", "source"].includes(key.toLowerCase()))
        url.searchParams.delete(key);
    return url.toString();
  } catch {
    return null;
  }
}

const TITLE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "api",
  "available",
  "for",
  "from",
  "in",
  "launch",
  "latest",
  "model",
  "new",
  "now",
  "official",
  "release",
  "released",
  "support",
  "the",
  "to",
  "update",
  "version",
  "with",
]);

function titleTerms(record: RecordData | null): Set<string> {
  const title = record?.name ?? record?.title;
  return new Set(
    normalized(title)
      .split(" ")
      .filter((term) => term.length >= 2 && !TITLE_STOP_WORDS.has(term)),
  );
}

function compatibleVendor(left: string, right: string): boolean {
  return left === "Unknown" || right === "Unknown" || left === right;
}

function similarTitle(left: Set<string>, right: Set<string>): boolean {
  if (left.size < 2 || right.size < 2) return false;
  const overlap = [...left].filter((term) => right.has(term)).length;
  const smaller = Math.min(left.size, right.size);
  return overlap >= 3 || (overlap >= 2 && overlap / smaller >= 0.75);
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

function cloneProjection(projection: StoryProjection): StoryProjection {
  const groups = projection.groups.map((group) => ({
    ...group,
    identity: { ...group.identity, aliases: [...group.identity.aliases] },
    terms: new Set(group.terms),
    urls: new Set(group.urls),
    titleTerms: new Set(group.titleTerms),
  }));
  const copies = new Map(projection.groups.map((group, index) => [group, groups[index] as StoryGroup]));
  return {
    groups,
    current: new Map([...projection.current].map(([key, group]) => [key, copies.get(group) as StoryGroup])),
    aliases: new Map([...projection.aliases].map(([key, group]) => [key, copies.get(group) as StoryGroup])),
    lastEventId: projection.lastEventId,
    lastDetectedAt: projection.lastDetectedAt,
  };
}

function emptyProjection(): StoryProjection {
  return { groups: [], current: new Map(), aliases: new Map(), lastEventId: 0, lastDetectedAt: null };
}

function projectEvent(projection: StoryProjection, event: StoryEvent): StoryGroup {
  const record = recordFor(event);
  const identity = identityFor(event, record);
  // GitHub records carry repository scope but no model identity. Their display names are not
  // evidence that two independent repository events describe the same subject.
  const terms = event.source.startsWith("github:") ? [] : identityTerms(identity);
  const url = event.source.startsWith("github:") ? null : canonicalUrl(record?.url);
  const titles = event.source.startsWith("github:") ? new Set<string>() : titleTerms(record);
  const { key, subject, vendor } = baseKeyFor(event, record);
  const identityMatch =
    terms.map((term) => projection.aliases.get(`${normalized(vendor)}:${term}`)).find((group) => group !== undefined) ??
    projection.current.get(key);
  const previous =
    identityMatch ??
    [...projection.groups].reverse().find((group) => {
      const lastTime = Date.parse(group.last.detected_at);
      const eventTime = Date.parse(event.detected_at);
      if (!Number.isFinite(lastTime) || !Number.isFinite(eventTime) || eventTime - lastTime > CORRELATION_WINDOW_MS)
        return false;
      if (!compatibleVendor(group.vendor, vendor)) return false;
      return (url !== null && group.urls.has(url)) || similarTitle(group.titleTerms, titles);
    });
  const last = previous?.last;
  if (!previous || !last || Date.parse(event.detected_at) - Date.parse(last.detected_at) > CORRELATION_WINDOW_MS) {
    const group = {
      baseKey: key,
      subject,
      vendor,
      firstEventId: event.id,
      firstDetectedAt: event.detected_at,
      last: event,
      identity,
      terms: new Set(terms),
      urls: new Set(url ? [url] : []),
      titleTerms: new Set(titles),
    };
    projection.groups.push(group);
    projection.current.set(key, group);
    for (const term of terms) projection.aliases.set(`${normalized(vendor)}:${term}`, group);
    return group;
  }
  previous.last = event;
  previous.identity = mergeIdentities(previous.identity, identity);
  projection.current.set(key, previous);
  for (const term of terms) {
    previous.terms.add(term);
    projection.aliases.set(`${normalized(vendor)}:${term}`, previous);
  }
  if (url) previous.urls.add(url);
  for (const term of titles) previous.titleTerms.add(term);
  return previous;
}

function storyKey(group: StoryGroup): string {
  return `${group.baseKey}:${group.firstEventId}`;
}

function storyTitle(group: StoryGroup): string {
  const record = recordFor(group.last);
  return String(record?.name ?? record?.model ?? group.subject);
}

function writeGroup(db: Database, group: StoryGroup): number {
  const status = group.last.kind === "removed" ? "removed" : "active";
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
      storyKey(group),
      storyTitle(group),
      group.subject,
      group.vendor,
      group.firstDetectedAt,
      group.last.detected_at,
      group.last.confidence,
      status,
    );
  if (!story) throw new Error(`Story ${storyKey(group)} could not be stored`);
  group.storyId = story.id;
  return story.id;
}

function linkEvent(db: Database, group: StoryGroup, event: StoryEvent): void {
  if (group.storyId === undefined) throw new Error(`Story ${storyKey(group)} has no database ID`);
  db.query("INSERT OR IGNORE INTO story_events(story_id,event_id) VALUES(?,?)").run(group.storyId, event.id);
}

function storyEvents(db: Database, afterId?: number): StoryEvent[] {
  return db
    .query<StoryEvent, number[] | []>(
      `SELECT id,source,stream,entity_id,kind,before_json,after_json,detected_at,confidence,evidence_type,authority
       FROM events ${afterId === undefined ? "" : "WHERE id>?"} ORDER BY detected_at,id`,
    )
    .all(...(afterId === undefined ? [] : [afterId]));
}

function rebuildProjection(db: Database): StoryProjection {
  const projection = emptyProjection();
  const events = storyEvents(db);
  const existing = db.query<{ stable_key: string }, []>("SELECT stable_key FROM stories").all();
  db.exec("DELETE FROM story_events");
  for (const event of events) {
    const group = projectEvent(projection, event);
    writeGroup(db, group);
    linkEvent(db, group, event);
    projection.lastDetectedAt = event.detected_at;
  }
  projection.lastEventId = events.reduce((max, event) => Math.max(max, event.id), 0);
  const keys = new Set(projection.groups.map(storyKey));
  for (const row of existing)
    if (!keys.has(row.stable_key)) db.query("DELETE FROM stories WHERE stable_key=?").run(row.stable_key);
  return projection;
}

/** Rebuilds the derived story projection; event evidence is never rewritten. The caller owns the transaction. */
export function rebuildStories(db: Database): StoryProjection {
  return rebuildProjection(db);
}

/** Projects only events appended after the last committed projection. Out-of-order timestamps use a full rebuild. */
export function updateStories(db: Database): StoryProjection {
  const cached = projections.get(db);
  if (!cached) return rebuildProjection(db);
  const currentEventId = Number(db.query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM events").get()?.id ?? 0);
  if (currentEventId < cached.lastEventId) return rebuildProjection(db);
  const events = storyEvents(db, cached.lastEventId);
  if (!events.length) return cached;
  const lastTime = cached.lastDetectedAt ? Date.parse(cached.lastDetectedAt) : null;
  if (
    lastTime !== null &&
    (!Number.isFinite(lastTime) || events.some((event) => Date.parse(event.detected_at) < lastTime))
  )
    return rebuildProjection(db);
  const projection = cloneProjection(cached);
  for (const event of events) {
    const group = projectEvent(projection, event);
    writeGroup(db, group);
    linkEvent(db, group, event);
    projection.lastDetectedAt = event.detected_at;
  }
  projection.lastEventId = events.reduce((max, event) => Math.max(max, event.id), projection.lastEventId);
  return projection;
}

export function rememberStoryProjection(db: Database, projection: StoryProjection): void {
  projections.set(db, projection);
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
  authorities: SourceAuthority[];
  sources: string[];
  sourceFamilies: string[];
  evidenceCoverage: {
    eventCount: number;
    sourceCount: number;
    sourceFamilies: string[];
    evidenceTypes: EvidenceType[];
    independentSourceCount: number;
    corroborated: boolean;
  };
  eventIds: number[];
  evidence: {
    eventId: number;
    source: string;
    kind: Event["kind"];
    confidence: Confidence;
    evidenceType: EvidenceType;
    authority: SourceAuthority;
    sourceFamily: string;
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
  const since = query.since ? Date.parse(query.since) : null;
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
    .filter((row) => since === null || Date.parse(row.updated_at) >= since)
    .filter((row) => !query.vendor || row.vendor.toLowerCase() === query.vendor.toLowerCase())
    .slice(0, query.limit ?? 50);
  return rows.map((row) => {
    const evidence = db
      .query<StoryEvidenceRow, [number]>(
        "SELECT e.id,e.source,e.stream,e.entity_id,e.kind,e.before_json,e.after_json,e.detected_at,e.confidence,e.evidence_type,e.authority,MIN(be.url) AS url FROM story_events se JOIN events e ON e.id=se.event_id LEFT JOIN batch_events be ON be.event_id=e.id WHERE se.story_id=? GROUP BY e.id ORDER BY e.detected_at,e.id",
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
          authority: event.authority ?? authorityForSource(event.source),
          sourceFamily: sourceFamily(event.source, event.stream),
          canonicalId: identity.canonicalId,
          identityStatus: identity.status,
          aliases: identity.aliases,
          detectedAt: event.detected_at,
          url: event.url,
        };
      });
    const sources = [...new Set(evidence.map((event) => event.source))];
    const sourceFamilies = [...new Set(evidence.map((event) => event.sourceFamily))];
    const evidenceTypes = [...new Set(evidence.map((event) => event.evidenceType))];
    const authorities = [...new Set(evidence.map((event) => event.authority))];
    const independentSources = new Set(
      evidence.map((event) =>
        event.authority !== "third_party" && row.vendor !== "Unknown"
          ? `${event.authority}:${row.vendor}`
          : `family:${event.sourceFamily}`,
      ),
    );
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
      authorities,
      sources,
      sourceFamilies,
      evidenceCoverage: {
        eventCount: evidence.length,
        sourceCount: sources.length,
        sourceFamilies,
        evidenceTypes,
        independentSourceCount: independentSources.size,
        corroborated: independentSources.size >= 2,
      },
      eventIds: evidence.map((event) => event.eventId),
      evidence,
    };
  });
}
