import { expect, test } from "bun:test";
import { saveCollection } from "../src/events/pipeline.js";
import type { Collection } from "../src/events/types.js";
import { getModelFacts, listModelFacts, rebuildModelFacts } from "../src/modelFacts.js";
import { openDatabase } from "../src/storage/database.js";
import { rebuildStories } from "../src/stories.js";
import { registered } from "./registered.js";

function observe(
  db: ReturnType<typeof openDatabase>,
  source: string,
  stream: Collection["stream"],
  records: Collection["records"],
  at: string,
  options: Partial<Collection> = {},
): void {
  saveCollection(
    db,
    registered({
      source,
      stream,
      url: `https://example.test/${encodeURIComponent(source)}`,
      raw: records,
      appendOnly: true,
      ...options,
      records,
    }),
    [],
    at,
  );
}

function introduce(
  db: ReturnType<typeof openDatabase>,
  source: string,
  stream: Collection["stream"],
  records: Collection["records"],
  at: string,
  options: Partial<Collection> = {},
): void {
  observe(db, source, stream, [], at, options);
  observe(db, source, stream, records, new Date(Date.parse(at) + 60_000).toISOString(), options);
}

const model = (fields: Record<string, unknown> = {}) => ({
  id: "openai/gpt-6",
  name: "GPT-6",
  ...fields,
});

test("higher confidence replaces weaker Model Facts with exact provenance", () => {
  const db = openDatabase(":memory:");
  introduce(
    db,
    "openrouter",
    "openrouter",
    [model({ context: 128000, name: "GPT-6 weak" })],
    "2026-09-10T00:00:00.000Z",
  );
  introduce(
    db,
    "openai",
    "api-models",
    [model({ context: 256000, name: "GPT-6 official" })],
    "2026-09-10T01:00:00.000Z",
  );

  const view = getModelFacts(db, "openai/gpt-6");
  expect(view?.facts.displayName).toMatchObject({
    value: "GPT-6 official",
    confidence: "confirmed",
    evidenceType: "api_catalogue",
    source: "openai",
    eventId: 2,
    observedAt: "2026-09-10T01:01:00.000Z",
  });
  expect(view?.facts.contextWindow).toMatchObject({ value: 256000, source: "openai", eventId: 2 });
  expect(listModelFacts(db, { limit: 100 })).toHaveLength(1);
  db.close();
});

test("weaker evidence cannot overwrite stronger facts and newer equal evidence wins", () => {
  const db = openDatabase(":memory:");
  introduce(db, "openai", "api-models", [model({ context: 256000 })], "2026-09-10T00:00:00.000Z");
  introduce(db, "openrouter", "openrouter", [model({ context: 128000 })], "2026-09-10T01:00:00.000Z");
  expect(getModelFacts(db, "openai/gpt-6")?.facts.contextWindow).toMatchObject({ value: 256000, source: "openai" });

  // An aggregator republishing a catalogue is `observed`, however recent and however many of them
  // agree: the vendor is the one answering for its own product.
  introduce(db, "catalogue-a", "api-models", [model({ context: 128000 })], "2026-09-10T02:00:00.000Z");
  introduce(db, "catalogue-b", "api-models", [model({ context: 192000 })], "2026-09-10T03:00:00.000Z");
  expect(getModelFacts(db, "openai/gpt-6")?.facts.contextWindow).toMatchObject({
    value: 256000,
    source: "openai",
    eventId: 1,
  });

  // Between two vendors answering at the same strength, the later reading is the current one.
  introduce(db, "gemini", "api-models", [model({ context: 320000 })], "2026-09-10T04:00:00.000Z");
  expect(getModelFacts(db, "openai/gpt-6")?.facts.contextWindow).toMatchObject({
    value: 320000,
    source: "gemini",
    eventId: 5,
  });
  db.close();
});

test("equal-strength disagreement is retained as a conflict", () => {
  const db = openDatabase(":memory:");
  introduce(db, "catalogue-a", "api-models", [model({ context: 128000 })], "2026-09-10T00:00:00.000Z");
  introduce(db, "catalogue-b", "api-models", [model({ context: 256000 })], "2026-09-10T01:00:00.000Z");
  expect(getModelFacts(db, "openai/gpt-6")?.conflicts).toEqual([
    {
      field: "contextWindow",
      incumbentEventId: 1,
      challengerEventId: 2,
      detectedAt: "2026-09-10T01:01:00.000Z",
    },
  ]);
  db.close();
});

test("a later value from the same source is history, not a conflict", () => {
  const db = openDatabase(":memory:");
  const options = { trackChanges: true };
  introduce(db, "openai", "api-models", [model({ context: 128000 })], "2026-09-10T00:00:00.000Z", options);
  introduce(db, "openai", "api-models", [model({ context: 256000 })], "2026-09-10T01:00:00.000Z", options);
  expect(getModelFacts(db, "openai/gpt-6")?.facts.contextWindow).toMatchObject({
    value: 256000,
    source: "openai",
    eventId: 2,
  });
  expect(getModelFacts(db, "openai/gpt-6")?.conflicts).toEqual([]);
  db.close();
});

test("OpenRouter array output becomes modalities and numeric output becomes max tokens", () => {
  const db = openDatabase(":memory:");
  introduce(
    db,
    "openrouter",
    "openrouter",
    [model({ input: ["text"], output: ["image", "text"] })],
    "2026-09-10T00:00:00.000Z",
  );
  introduce(db, "vercel-gateway", "api-models", [model({ output: 4096 })], "2026-09-10T01:00:00.000Z");
  const facts = getModelFacts(db, "openai/gpt-6")?.facts;
  expect(facts?.outputModalities).toMatchObject({ value: ["image", "text"], source: "openrouter" });
  expect(facts?.maxOutputTokens).toMatchObject({ value: 4096, source: "vercel-gateway" });
  expect(facts?.availableInProviderApi).toBeUndefined();
  db.close();
});

test("provider API availability comes only from first-party catalogues", () => {
  const db = openDatabase(":memory:");
  introduce(db, "vercel-gateway", "api-models", [model()], "2026-09-10T00:00:00.000Z");
  expect(getModelFacts(db, "openai/gpt-6")?.facts.availableInProviderApi).toBeUndefined();

  introduce(db, "openai", "api-models", [model()], "2026-09-10T01:00:00.000Z");
  expect(getModelFacts(db, "openai/gpt-6")?.facts["availableInProviderApi:openai"]).toMatchObject({
    value: true,
    source: "openai",
  });
  db.close();
});

// Current records carry no authority, and a second list of it had every generic provider catalogue
// reading as third-party: MiMo's own catalogue was `observed` and never made a provider-API fact.
test("a generic provider catalogue's current records carry the authority its registry entry declares", () => {
  const db = openDatabase(":memory:");
  observe(db, "mimo", "api-models", [model()], "2026-09-10T00:00:00.000Z");
  rebuildModelFacts(db);
  expect(getModelFacts(db, "openai/gpt-6")?.facts["availableInProviderApi:mimo"]).toMatchObject({
    value: true,
    confidence: "confirmed",
    evidenceType: "api_catalogue",
    eventId: null,
  });
  db.close();
});

test("baseline records create facts without inventing an event", () => {
  const db = openDatabase(":memory:");
  observe(
    db,
    "openrouter",
    "openrouter",
    [model({ pricing: { prompt: "0.000001" }, access: "public" })],
    "2026-09-10T00:00:00.000Z",
  );
  const facts = getModelFacts(db, "openai/gpt-6")?.facts;
  expect(facts?.displayName).toMatchObject({ value: "GPT-6", eventId: null, source: "openrouter" });
  expect(facts?.["pricing:openrouter"]).toMatchObject({ value: { prompt: "0.000001" }, eventId: null });
  expect(facts?.["access:openrouter"]).toMatchObject({ value: "public", eventId: null });
  expect(db.query("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
  db.close();
});

test("a field removed from the current catalogue does not retain stale history", () => {
  const db = openDatabase(":memory:");
  const first = { ...model({ context: 128000 }), id: "openai/gpt-6" };
  const second = { ...model(), id: "openai/gpt-6" };
  observe(db, "openrouter", "openrouter", [first], "2026-09-10T00:00:00.000Z", { appendOnly: false });
  observe(db, "openrouter", "openrouter", [second], "2026-09-10T01:00:00.000Z", { appendOnly: false });
  expect(getModelFacts(db, "openai/gpt-6")?.facts.contextWindow).toBeUndefined();
  expect(getModelFacts(db, "openai/gpt-6")?.facts.displayName).toMatchObject({ value: "GPT-6", eventId: 1 });
  db.close();
});

test("lifecycle sources contribute status and dates to Model Facts", () => {
  const db = openDatabase(":memory:");
  introduce(
    db,
    "gemini-deprecations",
    "deprecations",
    [
      model({
        id: "gemini-2.0-flash",
        name: "Gemini 2.0 Flash",
        modelId: "gemini-2.0-flash",
        maker: "Google Gemini",
        provider: "Google Gemini",
        stage: "Deprecated",
        deprecated: "2026-09-20",
        retirement: "2026-10-01",
      }),
    ],
    "2026-09-10T00:00:00.000Z",
  );
  const facts = getModelFacts(db, "gemini-2.0-flash")?.facts;
  expect(facts?.status).toMatchObject({ value: "Deprecated", source: "gemini-deprecations" });
  expect(facts?.deprecationDate).toMatchObject({ value: "2026-09-20", source: "gemini-deprecations" });
  expect(facts?.retirementDate).toMatchObject({ value: "2026-10-01", source: "gemini-deprecations" });
  db.close();
});

test("known source vendor wins over a raw provider owner", () => {
  const db = openDatabase(":memory:");
  introduce(
    db,
    "openai",
    "api-models",
    [model({ owner: "internal-api-owner", maker: undefined })],
    "2026-09-10T00:00:00.000Z",
  );
  expect(getModelFacts(db, "openai/gpt-6")?.facts.provider).toMatchObject({ value: "OpenAI", source: "openai" });
  db.close();
});

test("removing a model from OpenRouter sets availability false", () => {
  const db = openDatabase(":memory:");
  const collection = (records: Collection["records"]): Collection => ({
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai",
    raw: records,
    records,
  });
  saveCollection(db, collection([model(), { id: "keep", name: "Keep" }]), [], "2026-09-10T00:00:00.000Z");
  saveCollection(db, collection([{ id: "keep", name: "Keep" }]), [], "2026-09-10T01:00:00.000Z");
  saveCollection(db, collection([{ id: "keep", name: "Keep" }]), [], "2026-09-10T02:00:00.000Z");
  expect(getModelFacts(db, "openai/gpt-6")?.facts["availableOnOpenRouter:openrouter"]).toMatchObject({
    value: false,
    eventId: 1,
    source: "openrouter",
  });
  db.close();
});

test("rebuilding Model Facts twice is deterministic and creates no events", () => {
  const db = openDatabase(":memory:");
  introduce(db, "openai", "api-models", [model({ context: 256000 })], "2026-09-10T00:00:00.000Z");
  const eventCount = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count;
  const rebuild = () => {
    db.transaction(() => {
      rebuildStories(db);
      rebuildModelFacts(db);
    })();
  };
  rebuild();
  const first = db.query("SELECT * FROM model_fact_fields ORDER BY canonical_id,field").all();
  rebuild();
  const second = db.query("SELECT * FROM model_fact_fields ORDER BY canonical_id,field").all();
  expect(second).toEqual(first);
  expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count).toBe(eventCount);
  db.close();
});

/** The three projected tables, in a fixed order, as one comparable string. */
function projected(db: ReturnType<typeof openDatabase>): string {
  return JSON.stringify({
    facts: db
      .query("SELECT canonical_id,canonical_key,first_seen_at,updated_at FROM model_facts ORDER BY canonical_id")
      .all(),
    fields: db
      .query(
        `SELECT canonical_id,field,value_json,confidence,evidence_type,source,event_id,observed_at
         FROM model_fact_fields ORDER BY canonical_id,field,source,event_id`,
      )
      .all(),
    conflicts: db
      .query(
        `SELECT canonical_id,field,incumbent_event_id,challenger_event_id,detected_at
         FROM model_fact_conflicts ORDER BY canonical_id,field,incumbent_event_id,challenger_event_id`,
      )
      .all(),
  });
}

test("an incrementally updated projection equals a full rebuild of the same evidence", () => {
  const db = openDatabase(":memory:");
  // Several models across several sources, with disagreement, a correction, and a model that only
  // ever appears in current records. Every `observe` goes through the incremental path.
  introduce(db, "openrouter", "openrouter", [model({ context: 128000 })], "2026-09-10T00:00:00.000Z");
  introduce(
    db,
    "models-dev",
    "api-models",
    [model({ context: 200000 }), { id: "anthropic/claude-9", name: "Claude 9", context: 500000 }],
    "2026-09-11T00:00:00.000Z",
  );
  // Equal strength from independent sources disagreeing: the conflict's incumbent depends on the
  // order candidates are seen in, which is what an incremental subset most easily gets wrong.
  introduce(db, "vercel-gateway", "api-models", [model({ context: 300000 })], "2026-09-12T00:00:00.000Z");
  // A model whose name is spelled differently by a second source: the kept spelling is whichever
  // member the projection meets first, so a subset read out of order changes it.
  introduce(
    db,
    "openrouter",
    "openrouter",
    [{ id: "qwen/Qwen3.5-9B", name: "Qwen3.5-9B" }],
    "2026-09-13T00:00:00.000Z",
  );
  introduce(db, "models-dev", "api-models", [{ id: "qwen3-5-9b", name: "qwen3-5-9b" }], "2026-09-14T00:00:00.000Z");

  const incremental = projected(db);
  expect(JSON.parse(incremental).facts.length).toBeGreaterThan(1);

  rebuildModelFacts(db);
  // Not "close to": the same bytes. An incremental projection that merely approximates the full one
  // corrupts derived data slowly, and nothing downstream would report it.
  expect(projected(db)).toBe(incremental);
  db.close();
});

test("a model that loses its last evidence loses its row, and its neighbours keep theirs", () => {
  const db = openDatabase(":memory:");
  introduce(
    db,
    "openrouter",
    "openrouter",
    [model(), { id: "qwen/qwen4", name: "Qwen 4" }],
    "2026-09-10T00:00:00.000Z",
  );
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM model_facts").get()?.n).toBeGreaterThanOrEqual(2);
  // The catalogue stops listing one of the two; the other must be untouched by the recomputation.
  observe(db, "openrouter", "openrouter", [model()], "2026-09-15T00:00:00.000Z");
  const incremental = projected(db);
  rebuildModelFacts(db);
  expect(projected(db)).toBe(incremental);
  db.close();
});
