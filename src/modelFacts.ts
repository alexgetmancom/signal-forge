import type { Database } from "bun:sqlite";
import { canonical } from "./events/canonical.js";
import { confidenceFor, confidenceRank, evidenceTypeFor } from "./events/confidence.js";
import { identityFor, type ModelIdentity, mergeIdentities, normalizeIdentity } from "./events/identity.js";
import { vendorOf } from "./events/interpretation.js";
import { recordFor } from "./events/record.js";
import { sourceFamily } from "./events/sourceFamily.js";
import type { Confidence, Event, EvidenceType, RecordData, SourceAuthority } from "./events/types.js";
import { measure } from "./runtime/metrics.js";
import { text } from "./text.js";

type ModelFact<T = unknown> = {
  value: T;
  confidence: Confidence;
  evidenceType: EvidenceType;
  source: string;
  eventId: number | null;
  observedAt: string;
};

type ModelFactConflict = {
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

type EventRow = Event & { confidence: Confidence; evidence_type: EvidenceType; authority: SourceAuthority };
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
type CurrentRecordRow = {
  source: string;
  id: string;
  body: string;
  stream: string;
  observed_at: string;
  authority: SourceAuthority;
};

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
  // The provider answering for its own catalogue, not a gateway or aggregator relisting it.
  if (event.stream === "api-models" && event.authority === "first_party")
    add("availableInProviderApi", event.kind !== "removed");
  if (event.stream === "openrouter") add("availableOnOpenRouter", event.kind !== "removed");
  return result;
}

/**
 * Ordered by story so the caller can close one story's run of events before opening the next and
 * never hold the whole join in memory; it read 13358 rows on the production database.
 */
function currentEvent(row: CurrentRecordRow): EventRow {
  return {
    signal: null,
    id: 0,
    source: row.source,
    stream: row.stream,
    entity_id: row.id,
    kind: "changed",
    before_json: null,
    after_json: row.body,
    detected_at: row.observed_at,
    confidence: confidenceFor(row.source, row.stream, row.authority),
    evidence_type: evidenceTypeFor(row.source, row.stream, row.authority),
    authority: row.authority,
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

/**
 * The projection itself: story evidence and current records in, Model Facts out. No database.
 *
 * Full and incremental rebuilds are the same code over different input, rather than two
 * implementations that have to be kept agreeing. Everything here partitions by model --
 * `selectCandidates` keys on the normalized identity, the cross-filters below key on it, the
 * aggregate is per model -- so feeding it every member of a subset of models produces exactly the
 * rows a full run would produce for those models, provided the members arrive in the same order.
 * That ordering is the one invariant this rests on, and it is why both callers read with the same
 * `ORDER BY`.
 */
type Projected = {
  models: Map<string, ModelAggregate>;
  selected: Map<string, Candidate>;
  conflicts: ModelFactConflict[];
  candidates: Candidate[];
  /** Which model each story and record was counted under, for the membership index. */
  members: { kind: "story" | "record"; ref: string; key: string }[];
};

function projectModelFacts(storyRows: Iterable<StoryEventRow>, recordRows: Iterable<CurrentRecordRow>): Projected {
  const models = new Map<string, ModelAggregate>();
  const historicalCandidates: Candidate[] = [];
  const members: Projected["members"] = [];
  const closeStory = (events: StoryEventRow[]): void => {
    const first = events[0];
    if (!first) return;
    let identity = emptyIdentity();
    for (const event of events) identity = mergeIdentities(identity, identityFor(event, recordFor(event)));
    if (!identity.canonicalId) return;
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
    members.push({ kind: "story", ref: String(first.story_id), key });
    for (const event of events) historicalCandidates.push(...extractCandidates(event, aggregate.canonicalId));
  };

  let storyId: number | null = null;
  let run: StoryEventRow[] = [];
  for (const row of storyRows) {
    if (row.story_id !== storyId) {
      if (storyId !== null) closeStory(run);
      storyId = row.story_id;
      run = [];
    }
    run.push(row);
  }
  if (storyId !== null) closeStory(run);

  const currentCandidates: Candidate[] = [];
  const currentFieldsByModel = new Map<string, Set<string>>();
  for (const row of recordRows) {
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
    members.push({ kind: "record", ref: recordRef(row.source, row.id), key });
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
  return { models, selected: selected.selected, conflicts: selected.conflicts, candidates, members };
}

/** A record is identified by its source and its id together; neither is unique alone. */
function recordRef(source: string, id: string): string {
  return `${source}\u0000${id}`;
}

const STORY_EVENTS_SQL = `SELECT s.id AS story_id,s.stable_key,s.first_seen_at,s.updated_at,
        e.id,e.source,e.stream,e.entity_id,e.kind,e.before_json,e.after_json,e.detected_at,
        e.confidence,e.evidence_type,e.authority
 FROM stories s
 JOIN story_events se ON se.story_id=s.id
 JOIN events e ON e.id=se.event_id`;

const RECORDS_SQL = `SELECT r.source,r.id,r.body,r.stream,r.observed_at,COALESCE(s.authority,'third_party') AS authority
 FROM records r LEFT JOIN sources s ON s.id=r.source`;

/**
 * The order both readers use.
 *
 * `selectCandidates` keeps the first candidate it sees for a field and replaces it only on a strict
 * win, and a conflict records which one was the incumbent. Order is therefore part of the answer,
 * not a detail of the loop, and an incremental run that read its subset in a different order would
 * produce different conflicts from the same evidence.
 */
const STORY_ORDER = " ORDER BY s.id,e.detected_at,e.id";
const RECORD_ORDER = " ORDER BY r.source,r.id";

function allStoryRows(db: Database): IterableIterator<StoryEventRow> {
  return db.query<StoryEventRow, []>(STORY_EVENTS_SQL + STORY_ORDER).iterate() as IterableIterator<StoryEventRow>;
}

function allRecordRows(db: Database): IterableIterator<CurrentRecordRow> {
  return db.query<CurrentRecordRow, []>(RECORDS_SQL + RECORD_ORDER).iterate() as IterableIterator<CurrentRecordRow>;
}

/** Writes one projection. `keys` limits the replacement to those models; null replaces everything. */
function writeModelFacts(db: Database, projection: Projected, keys: ReadonlySet<string> | null): void {
  if (keys === null) {
    db.exec(
      "DELETE FROM model_fact_conflicts; DELETE FROM model_fact_fields; DELETE FROM model_facts; DELETE FROM model_fact_members;",
    );
  } else {
    const dropFields = db.query(
      "DELETE FROM model_fact_fields WHERE canonical_id IN (SELECT canonical_id FROM model_facts WHERE canonical_key=?)",
    );
    const dropConflicts = db.query(
      "DELETE FROM model_fact_conflicts WHERE canonical_id IN (SELECT canonical_id FROM model_facts WHERE canonical_key=?)",
    );
    const dropFacts = db.query("DELETE FROM model_facts WHERE canonical_key=?");
    const dropMembers = db.query("DELETE FROM model_fact_members WHERE canonical_key=?");
    for (const key of keys) {
      dropConflicts.run(key);
      dropFields.run(key);
      dropFacts.run(key);
      dropMembers.run(key);
    }
  }

  const insertFact = db.query(
    "INSERT INTO model_facts(canonical_id,canonical_key,first_seen_at,updated_at) VALUES(?,?,?,?)",
  );
  for (const [key, aggregate] of [...projection.models.entries()].sort((left, right) =>
    left[1].canonicalId.localeCompare(right[1].canonicalId),
  ))
    insertFact.run(aggregate.canonicalId, key, aggregate.firstSeenAt, aggregate.updatedAt);

  const insertField = db.query(
    `INSERT INTO model_fact_fields(canonical_id,field,value_json,confidence,evidence_type,source,event_id,observed_at)
     VALUES(?,?,?,?,?,?,?,?)`,
  );
  const fields = [...projection.selected.values()].sort((left, right) => {
    const model = left.canonicalId.localeCompare(right.canonicalId);
    return model || left.field.localeCompare(right.field);
  });
  for (const item of fields)
    insertField.run(
      item.canonicalId,
      item.field,
      canonical(item.value),
      item.confidence,
      item.evidenceType,
      item.source,
      item.eventId,
      item.observedAt,
    );

  const insertConflict = db.query(
    `INSERT INTO model_fact_conflicts(canonical_id,field,incumbent_event_id,challenger_event_id,detected_at)
     VALUES(?,?,?,?,?)`,
  );
  for (const conflict of projection.conflicts.sort(
    (left, right) =>
      left.field.localeCompare(right.field) ||
      left.incumbentEventId - right.incumbentEventId ||
      left.challengerEventId - right.challengerEventId,
  )) {
    const canonicalId = projection.candidates.find(
      (item) => item.field === conflict.field && item.eventId === conflict.incumbentEventId,
    )?.canonicalId;
    if (!canonicalId) continue;
    insertConflict.run(
      canonicalId,
      conflict.field,
      conflict.incumbentEventId,
      conflict.challengerEventId,
      conflict.detectedAt,
    );
  }

  const insertMember = db.query("INSERT OR REPLACE INTO model_fact_members(kind,ref,canonical_key) VALUES(?,?,?)");
  for (const member of projection.members) insertMember.run(member.kind, member.ref, member.key);
}

/** Rebuilds Model Facts from current records plus immutable event evidence; the caller owns the transaction. */
export function rebuildModelFacts(db: Database): void {
  writeModelFacts(db, projectModelFacts(allStoryRows(db), allRecordRows(db)), null);
}

/** What a collection changed, as the projection sees it: stories carrying new events, and records. */
export type FactsDirty = { storyIds: readonly number[]; records: readonly { source: string; id: string }[] };

function chunked<T>(values: readonly T[], size = 400): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < values.length; start += size) out.push(values.slice(start, start + size));
  return out;
}

/**
 * Recomputes only the models a collection touched, and replaces only their rows.
 *
 * Which models those are takes two answers, not one. A changed member's *old* model has to be
 * recomputed because it may have lost evidence, and its *new* model because it may have gained
 * some -- a record whose identity was corrected moves between two models and leaves both wrong.
 * The old answer comes from the membership index, the new one from identifying the member now.
 *
 * Once the set is known, every member of every model in it is read back in the same order the full
 * rebuild reads them and handed to the same projection. Reading all of a model's members rather
 * than only the changed ones is what makes the result equal to a full rebuild instead of merely
 * close to it: the cross-filters and the aggregate are over a model's whole evidence, and a subset
 * of it would answer a different question. `rehearse-projections` checks that equality against real
 * history rather than trusting this paragraph.
 *
 * The two halves are timed apart because the whole was not an answer. `pipeline.model-facts` is
 * 113 ms on average over 26k calls and peaks at 11.7 s, all of it inside the poller's transaction
 * and so all of it holding the write lock -- and nothing in that number says whether the cost is
 * projecting in memory or replacing rows in SQLite, which are different repairs. So the projection,
 * including the reads it is driven by, is `pipeline.model-facts.project` and the replacement is
 * `pipeline.model-facts.write`; the enclosing name stays what it was, so the series that raised the
 * question keeps its ninety days of history to be compared against.
 */
export function updateModelFacts(db: Database, dirty: FactsDirty): void {
  const planned = measure(db, "pipeline.model-facts.project", () => projectDirty(db, dirty));
  if (!planned) return;
  measure(db, "pipeline.model-facts.write", () => writeModelFacts(db, planned.projection, planned.keys));
}

/** The models a collection touched and their projection, or null when it touched none. */
function projectDirty(db: Database, dirty: FactsDirty): { projection: Projected; keys: Set<string> } | null {
  const refs: { kind: "story" | "record"; ref: string }[] = [
    ...dirty.storyIds.map((id) => ({ kind: "story" as const, ref: String(id) })),
    ...dirty.records.map((record) => ({ kind: "record" as const, ref: recordRef(record.source, record.id) })),
  ];
  if (!refs.length) return null;

  const keys = new Set<string>();
  // The model each changed member used to belong to.
  const previous = db.query<{ canonical_key: string }, [string, string]>(
    "SELECT canonical_key FROM model_fact_members WHERE kind=? AND ref=?",
  );
  for (const entry of refs) {
    const row = previous.get(entry.kind, entry.ref);
    if (row) keys.add(row.canonical_key);
  }
  // And the model it belongs to now, which is only knowable by identifying it again.
  const fresh = projectModelFacts(storyRowsFor(db, dirty.storyIds), recordRowsFor(db, dirty.records));
  for (const member of fresh.members) keys.add(member.key);
  if (!keys.size) return null;

  // Every member of every affected model, in the full rebuild's order.
  const storyIds = new Set<number>();
  const records: { source: string; id: string }[] = [];
  const membersOf = db.query<{ kind: string; ref: string }, [string]>(
    "SELECT kind,ref FROM model_fact_members WHERE canonical_key=?",
  );
  for (const key of keys)
    for (const member of membersOf.all(key)) {
      if (member.kind === "story") storyIds.add(Number(member.ref));
      else {
        const [source, id] = member.ref.split("\u0000");
        if (source !== undefined && id !== undefined) records.push({ source, id });
      }
    }
  for (const id of dirty.storyIds) storyIds.add(id);
  for (const record of dirty.records) records.push(record);

  const projection = projectModelFacts(storyRowsFor(db, [...storyIds]), recordRowsFor(db, dedupeRecords(records)));
  return { projection, keys };
}

function dedupeRecords(records: readonly { source: string; id: string }[]): { source: string; id: string }[] {
  const seen = new Set<string>();
  const out: { source: string; id: string }[] = [];
  for (const record of records) {
    const ref = recordRef(record.source, record.id);
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(record);
  }
  return out;
}

/** The same query and the same order as the full rebuild, narrowed to these stories. */
function* storyRowsFor(db: Database, storyIds: readonly number[]): IterableIterator<StoryEventRow> {
  // Chunked to stay under the bound-parameter limit; the chunks are cut on story boundaries, and
  // the order within and between them is the order of `s.id`, so the sequence is unchanged.
  for (const chunk of chunked([...storyIds].sort((left, right) => left - right)))
    yield* db
      .query<StoryEventRow, number[]>(
        `${STORY_EVENTS_SQL} WHERE s.id IN (${chunk.map(() => "?").join(",")})${STORY_ORDER}`,
      )
      .all(...chunk);
}

function* recordRowsFor(
  db: Database,
  records: readonly { source: string; id: string }[],
): IterableIterator<CurrentRecordRow> {
  // Codepoint order, because that is what SQLite's `ORDER BY r.source,r.id` means: the default
  // collation is BINARY. Sorting the chunks with `localeCompare` put them in one order while the
  // rows inside each chunk came back in another, and the concatenation was neither -- which changed
  // which member of a model was seen first, and so which spelling of its name was kept. Caught by
  // `rehearse-projections` on real history: `Qwen3.5-9B` became `qwen3-5-9b`.
  const byCodepoint = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  const sorted = [...records].sort(
    (left, right) => byCodepoint(left.source, right.source) || byCodepoint(left.id, right.id),
  );
  for (const chunk of chunked(sorted))
    yield* db
      .query<CurrentRecordRow, string[]>(
        `${RECORDS_SQL} WHERE (r.source,r.id) IN (VALUES ${chunk.map(() => "(?,?)").join(",")})${RECORD_ORDER}`,
      )
      .all(...chunk.flatMap((record) => [record.source, record.id]));
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
