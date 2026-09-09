import { expect, test } from "bun:test";
import { type Collection, saveCollection } from "../src/events.js";
import { getModelFacts, listModelFacts, rebuildModelFacts } from "../src/modelFacts.js";
import { openDatabase } from "../src/storage/database.js";
import { rebuildStories } from "../src/stories.js";

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
    {
      source,
      stream,
      url: `https://example.test/${encodeURIComponent(source)}`,
      raw: records,
      appendOnly: true,
      ...options,
      records,
    },
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
  introduce(db, "openrouter", "openrouter", [model({ context: 128000, name: "GPT-6 weak" })], "2026-09-10T00:00:00Z");
  introduce(db, "openai", "api-models", [model({ context: 256000, name: "GPT-6 official" })], "2026-09-10T01:00:00Z");

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
  introduce(db, "openai", "api-models", [model({ context: 256000 })], "2026-09-10T00:00:00Z");
  introduce(db, "openrouter", "openrouter", [model({ context: 128000 })], "2026-09-10T01:00:00Z");
  expect(getModelFacts(db, "openai/gpt-6")?.facts.contextWindow).toMatchObject({ value: 256000, source: "openai" });

  introduce(db, "catalogue-a", "api-models", [model({ context: 128000 })], "2026-09-10T02:00:00Z");
  introduce(db, "catalogue-b", "api-models", [model({ context: 192000 })], "2026-09-10T03:00:00Z");
  expect(getModelFacts(db, "openai/gpt-6")?.facts.contextWindow).toMatchObject({
    value: 192000,
    source: "catalogue-b",
    eventId: 4,
  });
  db.close();
});

test("equal-strength disagreement is retained as a conflict", () => {
  const db = openDatabase(":memory:");
  introduce(db, "catalogue-a", "api-models", [model({ context: 128000 })], "2026-09-10T00:00:00Z");
  introduce(db, "catalogue-b", "api-models", [model({ context: 256000 })], "2026-09-10T01:00:00Z");
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

test("OpenRouter array output becomes modalities and numeric output becomes max tokens", () => {
  const db = openDatabase(":memory:");
  introduce(
    db,
    "openrouter",
    "openrouter",
    [model({ input: ["text"], output: ["image", "text"] })],
    "2026-09-10T00:00:00Z",
  );
  introduce(db, "vercel-gateway", "api-models", [model({ output: 4096 })], "2026-09-10T01:00:00Z");
  const facts = getModelFacts(db, "openai/gpt-6")?.facts;
  expect(facts?.outputModalities).toMatchObject({ value: ["image", "text"], source: "openrouter" });
  expect(facts?.maxOutputTokens).toMatchObject({ value: 4096, source: "vercel-gateway" });
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
  saveCollection(db, collection([model(), { id: "keep", name: "Keep" }]), [], "2026-09-10T00:00:00Z");
  saveCollection(db, collection([{ id: "keep", name: "Keep" }]), [], "2026-09-10T01:00:00Z");
  saveCollection(db, collection([{ id: "keep", name: "Keep" }]), [], "2026-09-10T02:00:00Z");
  expect(getModelFacts(db, "openai/gpt-6")?.facts.availableOnOpenRouter).toMatchObject({
    value: false,
    eventId: 1,
    source: "openrouter",
  });
  db.close();
});

test("rebuilding Model Facts twice is deterministic and creates no events", () => {
  const db = openDatabase(":memory:");
  introduce(db, "openai", "api-models", [model({ context: 256000 })], "2026-09-10T00:00:00Z");
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
