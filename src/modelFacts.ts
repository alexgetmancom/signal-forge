import type { Database } from "bun:sqlite";
import { canonical } from "./events/canonical.js";
import { authorityForSource, confidenceFor, confidenceRank, evidenceTypeFor } from "./events/confidence.js";
import { identityFor, type ModelIdentity, mergeIdentities, normalizeIdentity } from "./events/identity.js";
import { vendorOf } from "./events/interpretation.js";
import { recordFor } from "./events/record.js";
import { sourceFamily } from "./events/sourceFamily.js";
import type { Confidence, Event, EvidenceType, RecordData } from "./events/types.js";
import { text } from "./text.js";

const FIRST_PARTY_API_CATALOGUE_SOURCES = new Set([
  "openai",
  "anthropic",
  "gemini",
  "deepseek-api",
  "deepseek-pricing",
]);

export type ModelFact<T = unknown> = {
  value: T;
  confidence: Confidence;
  evidenceType: EvidenceType;
  source: string;
  eventId: number | null;
  observedAt: string;
};

export type ModelFactConflict = {
  field: string;
  incumbentEventId: number;
  challengerEventId: number;
  detectedAt: string;
};

export type ModelFactsView = {
  canonicalId: string;
  firstSeenAt: string;
  updatedAt: string;
  facts: Record<string, ModelFact>;
  conflicts: ModelFactConflict[];
};

export type ModelFactsQuery = { limit?: number | undefined };

/** Evidence authority is intentionally separate from confidence semantics. */
const MODEL_FACT_AUTHORITY_RANK: Record<EvidenceType, number> = {
  api_catalogue: 5,
  deprecation: 5,
  official_news: 4,
  availability_catalogue: 3,
  package_release: 3,
  open_weights: 3,
  arena_roster: 2,
  leaderboard: 2,
  github_activity: 2,
  web_diff: 2,
  status_page: 2,
  unknown: 1,
};

type EventRow = Event & { confidence: Confidence; evidence_type: EvidenceType };
type StoryEventRow = EventRow & {
  story_id: number;
  stable_key: string;
  first_seen_at: string;
  updated_at: string;
};
type Candidate = {
  canonicalId: string;
  field: string;
  value: unknown;
  confidence: Confidence;
  evidenceType: EvidenceType;
  source: string;
  sourceFamily: string;
  eventId: number | null;
  observedAt: string;
};
type ModelAggregate = { canonicalId: string; firstSeenAt: string; updatedAt: string };
type CurrentRecordRow = { source: string; id: string; body: string; stream: string; observed_at: string };

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function array(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function providerFor(event: Event, record: RecordData): string | null {
  const vendor = vendorOf(event, record);
  return vendor !== "Unknown" ? vendor : (text(record.maker) ?? text(record.owner) ?? text(record.provider));
}

function factField(event: EventRow, field: string): string {
  if (["pricing", "access", "availableInProviderApi", "availableOnOpenRouter", "openWeights"].includes(field))
    return `${field}:${event.source}`;
  return field;
}

function candidate(
  event: EventRow,
  canonicalId: string,
  field: string,
  value: unknown,
  eventId: number | null = event.id,
): Candidate | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && !value.trim()) return null;
  return {
    canonicalId,
    field: factField(event, field),
    value,
    confidence: event.confidence,
    evidenceType: event.evidence_type,
    source: event.source,
    sourceFamily: sourceFamily(event.source, event.stream),
    eventId,
    observedAt: event.detected_at,
  };
}

function extractCandidates(event: EventRow, canonicalId: string, eventId: number | null = event.id): Candidate[] {
  const record = recordFor(event);
  const result: Candidate[] = [];
  const add = (field: string, value: unknown): void => {
    const item = candidate(event, canonicalId, field, value, eventId);
    if (item) result.push(item);
  };

  if (record) {
    add("displayName", text(record.name));
    add("provider", providerFor(event, record));
    add("releaseDate", text(record.created));
    add("contextWindow", number(record.context) ?? number(record.inputTokenLimit));
    const output = Array.isArray(record.output) ? null : number(record.output);
    add("maxOutputTokens", output ?? number(record.outputTokenLimit));
    add("inputModalities", array(record.input));
    add("outputModalities", array(record.output));
    add("pricing", record.pricing);
    add("access", text(record.access));
    add("library", text(record.library));
    if (event.stream === "deprecations") {
      add("status", text(record.stage));
      add("deprecationDate", text(record.deprecated));
      add("retirementDate", text(record.retirement));
    }
  }

  if (event.stream === "weights") add("openWeights", event.kind !== "removed");
  if (FIRST_PARTY_API_CATALOGUE_SOURCES.has(event.source)) add("availableInProviderApi", event.kind !== "removed");
  if (event.stream === "openrouter") add("availableOnOpenRouter", event.kind !== "removed");
  return result;
}

function storyEvents(db: Database): StoryEventRow[] {
  return db
    .query<StoryEventRow, []>(
      `SELECT s.id AS story_id,s.stable_key,s.first_seen_at,s.updated_at,
              e.id,e.source,e.stream,e.entity_id,e.kind,e.before_json,e.after_json,e.detected_at,
              e.confidence,e.evidence_type
       FROM stories s
       JOIN story_events se ON se.story_id=s.id
       JOIN events e ON e.id=se.event_id
       ORDER BY s.id,e.detected_at,e.id`,
    )
    .all();
}

function currentEvent(row: CurrentRecordRow): EventRow {
  return {
    id: 0,
    source: row.source,
    stream: row.stream,
    entity_id: row.id,
    kind: "changed",
    before_json: null,
    after_json: row.body,
    detected_at: row.observed_at,
    confidence: confidenceFor(row.source, row.stream),
    evidence_type: evidenceTypeFor(row.source, row.stream),
    authority: authorityForSource(row.source),
  };
}

function emptyIdentity(): ModelIdentity {
  return { canonicalId: null, displayName: "", aliases: [], status: "unknown" };
}

function newer(left: Candidate, right: Candidate): boolean {
  const leftTime = Date.parse(left.observedAt);
  const rightTime = Date.parse(right.observedAt);
  if (leftTime !== rightTime) return leftTime > rightTime;
  if (left.eventId === null) return right.eventId !== null;
  if (right.eventId === null) return false;
  return left.eventId > right.eventId;
}

function stronger(left: Candidate, right: Candidate): number {
  const confidence = confidenceRank(left.confidence) - confidenceRank(right.confidence);
  if (confidence) return confidence;
  const authority = MODEL_FACT_AUTHORITY_RANK[left.evidenceType] - MODEL_FACT_AUTHORITY_RANK[right.evidenceType];
  if (authority) return authority;
  return newer(left, right) ? 1 : left.eventId === right.eventId ? 0 : -1;
}

function conflictKey(canonicalId: string, field: string, incumbentEventId: number, challengerEventId: number): string {
  return `${canonicalId}\u0000${field}\u0000${incumbentEventId}\u0000${challengerEventId}`;
}

function selectCandidates(candidates: Candidate[]): {
  selected: Map<string, Candidate>;
  conflicts: ModelFactConflict[];
} {
  const selected = new Map<string, Candidate>();
  const conflicts = new Map<string, ModelFactConflict>();
  for (const item of candidates) {
    const key = `${normalizeIdentity(item.canonicalId)}\u0000${item.field}`;
    const incumbent = selected.get(key);
    if (!incumbent) {
      selected.set(key, item);
      continue;
    }
    const sameStrength =
      confidenceRank(incumbent.confidence) === confidenceRank(item.confidence) &&
      MODEL_FACT_AUTHORITY_RANK[incumbent.evidenceType] === MODEL_FACT_AUTHORITY_RANK[item.evidenceType];
    const independentSources = incumbent.source !== item.source && incumbent.sourceFamily !== item.sourceFamily;
    if (
      sameStrength &&
      independentSources &&
      incumbent.eventId !== null &&
      item.eventId !== null &&
      canonical(incumbent.value) !== canonical(item.value)
    ) {
      const conflict = {
        field: item.field,
        incumbentEventId: incumbent.eventId,
        challengerEventId: item.eventId,
        detectedAt: newer(incumbent, item) ? incumbent.observedAt : item.observedAt,
      } satisfies ModelFactConflict;
      conflicts.set(
        conflictKey(item.canonicalId, item.field, conflict.incumbentEventId, conflict.challengerEventId),
        conflict,
      );
    }
    if (stronger(item, incumbent) > 0) selected.set(key, item);
  }
  return { selected, conflicts: [...conflicts.values()] };
}

function minInstant(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function maxInstant(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

/** Rebuilds Model Facts from current records plus immutable event evidence; the caller owns the transaction. */
export function rebuildModelFacts(db: Database): void {
  const rows = storyEvents(db);
  const byStory = new Map<number, StoryEventRow[]>();
  for (const row of rows) byStory.set(row.story_id, [...(byStory.get(row.story_id) ?? []), row]);

  const models = new Map<string, ModelAggregate>();
  const historicalCandidates: Candidate[] = [];
  for (const events of byStory.values()) {
    const first = events[0];
    if (!first) continue;
    let identity = emptyIdentity();
    for (const event of events) identity = mergeIdentities(identity, identityFor(event, recordFor(event)));
    if (!identity.canonicalId) continue;
    const canonicalId = identity.canonicalId;
    const key = normalizeIdentity(canonicalId);
    const existing = models.get(key);
    const aggregate = existing
      ? {
          ...existing,
          firstSeenAt: minInstant(existing.firstSeenAt, first.first_seen_at),
          updatedAt: maxInstant(existing.updatedAt, first.updated_at),
        }
      : { canonicalId, firstSeenAt: first.first_seen_at, updatedAt: first.updated_at };
    models.set(key, aggregate);
    for (const event of events) historicalCandidates.push(...extractCandidates(event, aggregate.canonicalId));
  }

  const currentCandidates: Candidate[] = [];
  const currentFieldsByModel = new Map<string, Set<string>>();
  const currentRows = db
    .query<CurrentRecordRow, []>("SELECT source,id,body,stream,observed_at FROM records ORDER BY source,id")
    .all();
  for (const row of currentRows) {
    const event = currentEvent(row);
    const identity = identityFor(event, recordFor(event));
    if (!identity.canonicalId) continue;
    const key = normalizeIdentity(identity.canonicalId);
    const existing = models.get(key);
    const aggregate = existing
      ? {
          ...existing,
          firstSeenAt: minInstant(existing.firstSeenAt, row.observed_at),
          updatedAt: maxInstant(existing.updatedAt, row.observed_at),
        }
      : { canonicalId: identity.canonicalId, firstSeenAt: row.observed_at, updatedAt: row.observed_at };
    models.set(key, aggregate);
    const extracted = extractCandidates(event, aggregate.canonicalId, null);
    currentCandidates.push(...extracted);
    const fields = currentFieldsByModel.get(key) ?? new Set<string>();
    for (const item of extracted) fields.add(item.field);
    currentFieldsByModel.set(key, fields);
  }

  const currentKeys = new Set(currentFieldsByModel.keys());
  const historicalSources = new Set(
    historicalCandidates.map((item) => `${normalizeIdentity(item.canonicalId)}\u0000${item.field}\u0000${item.source}`),
  );
  const candidates = [
    ...historicalCandidates.filter(
      (item) =>
        !currentKeys.has(normalizeIdentity(item.canonicalId)) ||
        currentFieldsByModel.get(normalizeIdentity(item.canonicalId))?.has(item.field),
    ),
    ...currentCandidates.filter(
      (item) => !historicalSources.has(`${normalizeIdentity(item.canonicalId)}\u0000${item.field}\u0000${item.source}`),
    ),
  ];
  const selected = selectCandidates(candidates);
  db.exec("DELETE FROM model_fact_conflicts; DELETE FROM model_fact_fields; DELETE FROM model_facts;");
  for (const aggregate of [...models.values()].sort((left, right) =>
    left.canonicalId.localeCompare(right.canonicalId),
  )) {
    db.query("INSERT INTO model_facts(canonical_id,first_seen_at,updated_at) VALUES(?,?,?)").run(
      aggregate.canonicalId,
      aggregate.firstSeenAt,
      aggregate.updatedAt,
    );
  }
  const fields = [...selected.selected.values()].sort((left, right) => {
    const model = left.canonicalId.localeCompare(right.canonicalId);
    return model || left.field.localeCompare(right.field);
  });
  for (const item of fields)
    db.query(
      `INSERT INTO model_fact_fields(canonical_id,field,value_json,confidence,evidence_type,source,event_id,observed_at)
       VALUES(?,?,?,?,?,?,?,?)`,
    ).run(
      item.canonicalId,
      item.field,
      canonical(item.value),
      item.confidence,
      item.evidenceType,
      item.source,
      item.eventId,
      item.observedAt,
    );
  for (const conflict of selected.conflicts.sort(
    (left, right) =>
      left.field.localeCompare(right.field) ||
      left.incumbentEventId - right.incumbentEventId ||
      left.challengerEventId - right.challengerEventId,
  )) {
    const canonicalId = candidates.find(
      (item) => item.field === conflict.field && item.eventId === conflict.incumbentEventId,
    )?.canonicalId;
    if (!canonicalId) continue;
    db.query(
      `INSERT INTO model_fact_conflicts(canonical_id,field,incumbent_event_id,challenger_event_id,detected_at)
       VALUES(?,?,?,?,?)`,
    ).run(canonicalId, conflict.field, conflict.incumbentEventId, conflict.challengerEventId, conflict.detectedAt);
  }
}

function view(db: Database, row: { canonical_id: string; first_seen_at: string; updated_at: string }): ModelFactsView {
  const fields = db
    .query<
      {
        field: string;
        value_json: string;
        confidence: Confidence;
        evidence_type: EvidenceType;
        source: string;
        event_id: number | null;
        observed_at: string;
      },
      [string]
    >(
      "SELECT field,value_json,confidence,evidence_type,source,event_id,observed_at FROM model_fact_fields WHERE canonical_id=? ORDER BY field",
    )
    .all(row.canonical_id);
  const facts: Record<string, ModelFact> = {};
  for (const field of fields) {
    facts[field.field] = {
      value: JSON.parse(field.value_json) as unknown,
      confidence: field.confidence,
      evidenceType: field.evidence_type,
      source: field.source,
      eventId: field.event_id,
      observedAt: field.observed_at,
    };
  }
  const conflicts = db
    .query<
      ModelFactConflict & {
        field: string;
        incumbent_event_id: number;
        challenger_event_id: number;
        detected_at: string;
      },
      [string]
    >(
      "SELECT field,incumbent_event_id,challenger_event_id,detected_at FROM model_fact_conflicts WHERE canonical_id=? ORDER BY detected_at,incumbent_event_id,challenger_event_id",
    )
    .all(row.canonical_id)
    .map((conflict) => ({
      field: conflict.field,
      incumbentEventId: conflict.incumbent_event_id,
      challengerEventId: conflict.challenger_event_id,
      detectedAt: conflict.detected_at,
    }));
  return { canonicalId: row.canonical_id, firstSeenAt: row.first_seen_at, updatedAt: row.updated_at, facts, conflicts };
}

export function listModelFacts(db: Database, query: ModelFactsQuery = {}): ModelFactsView[] {
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Model limit must be between 1 and 100");
  return db
    .query<{ canonical_id: string; first_seen_at: string; updated_at: string }, [number]>(
      "SELECT canonical_id,first_seen_at,updated_at FROM model_facts ORDER BY updated_at DESC,canonical_id LIMIT ?",
    )
    .all(limit)
    .map((row) => view(db, row));
}

export function getModelFacts(db: Database, canonicalId: string): ModelFactsView | null {
  const exact = db
    .query<{ canonical_id: string; first_seen_at: string; updated_at: string }, [string]>(
      "SELECT canonical_id,first_seen_at,updated_at FROM model_facts WHERE canonical_id=?",
    )
    .get(canonicalId);
  if (exact) return view(db, exact);
  const normalized = normalizeIdentity(canonicalId);
  const fallback = db
    .query<{ canonical_id: string; first_seen_at: string; updated_at: string }, []>(
      "SELECT canonical_id,first_seen_at,updated_at FROM model_facts ORDER BY canonical_id",
    )
    .all()
    .find((row) => normalizeIdentity(row.canonical_id) === normalized);
  return fallback ? view(db, fallback) : null;
}
