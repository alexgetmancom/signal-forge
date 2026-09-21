import { expect, test } from "bun:test";
import { classify } from "../src/events/classify.js";
import { saveCollection } from "../src/events/pipeline.js";
import { signalClass } from "../src/events/signals.js";
import type { Event } from "../src/events/types.js";
import { listedInCatalogue, olderThanKnown } from "../src/sources/mentionStage.js";
import { openDatabase } from "../src/storage/database.js";

const event = (over: Partial<Event> & { record: Record<string, unknown> }): Event => ({
  id: 1,
  source: "x",
  stream: "news",
  entity_id: String(over.record.id ?? "x"),
  kind: "new",
  before_json: null,
  after_json: JSON.stringify(over.record),
  detected_at: "2026-09-21T00:00:00.000Z",
  ...over,
});

test("a consumer ChatGPT feature is evidence; one about models still travels", () => {
  const notes = { source: "openai-chatgpt-release-notes", published: new Date().toISOString() };
  expect(
    signalClass(
      event({
        ...notes,
        record: {
          ...notes,
          id: "a",
          name: "Credit scores in Finances",
          summary: "Track your credit score in ChatGPT.",
        },
      }),
    ),
  ).toBe("evidence");
  expect(
    signalClass(
      event({
        ...notes,
        record: {
          ...notes,
          id: "c",
          name: "Privacy Center in ChatGPT",
          summary:
            "Brings together chat privacy, memory, personalization, data use, connected apps and account security.",
        },
      }),
    ),
  ).toBe("evidence");
  expect(
    signalClass(
      event({ ...notes, record: { ...notes, id: "b", name: "GPT-6 Astra in ChatGPT", summary: "Now available." } }),
    ),
  ).toBe("release");
});

test("catalogue lookups: a docs slug finds its launched model, an old model knows its successor", () => {
  const db = openDatabase(":memory:");
  saveCollection(
    db,
    {
      source: "openrouter",
      stream: "openrouter",
      url: "https://x",
      raw: [],
      records: [
        { id: "x-ai/grok-4.7", name: "Grok 4.7" },
        { id: "anthropic/claude-sonnet-4", name: "Sonnet 4" },
        { id: "anthropic/claude-sonnet-4.6", name: "Sonnet 4.6" },
      ],
    },
    [],
  );
  expect(listedInCatalogue(db, "grok-4-7")).toBe(true);
  expect(listedInCatalogue(db, "grok-4-8")).toBe(false);
  expect(olderThanKnown(db, "anthropic/claude-sonnet-4")).toBe(true);
  expect(olderThanKnown(db, "anthropic/claude-sonnet-4.6")).toBe(false);
  saveCollection(
    db,
    {
      source: "dashscope",
      stream: "api-models",
      url: "https://x",
      raw: [],
      records: [{ id: "glm-5.3", name: "GLM-5.3" }],
    },
    [],
  );
  const row = { source: "dashscope", stream: "api-models" };
  // A mode of a listed model is a trail; a mode whose base nobody sells is still the first word.
  expect(classify(db, event({ ...row, entity_id: "glm-5.3-prime", record: { id: "glm-5.3-prime" } }))).toBe("evidence");
  expect(classify(db, event({ ...row, entity_id: "glm-6-fast", record: { id: "glm-6-fast" } }))).toBe("codename");
  // A docs page for a model already on sale is late; one for a model nobody sells is a sighting.
  const page = { source: "pages:xai-docs", stream: "pages" };
  expect(
    classify(
      db,
      event({ ...page, entity_id: "/developers/grok-4-7", record: { id: "/developers/grok-4-7", name: "Grok 4 7" } }),
    ),
  ).toBe("evidence");
  expect(
    classify(
      db,
      event({ ...page, entity_id: "/developers/grok-4-8", record: { id: "/developers/grok-4-8", name: "Grok 4 8" } }),
    ),
  ).toBe("codename");
  // An old model's context moving is housekeeping; its price moving still travels.
  const or = { source: "openrouter", stream: "openrouter", kind: "changed" as const };
  const sonnet = { id: "anthropic/claude-sonnet-4", context_length: 200000, pricing: { prompt: 3 } };
  expect(
    classify(
      db,
      event({
        ...or,
        entity_id: sonnet.id,
        before_json: JSON.stringify({ ...sonnet, context_length: 1000000 }),
        record: sonnet,
      }),
    ),
  ).toBe("evidence");
  expect(
    classify(
      db,
      event({
        ...or,
        entity_id: sonnet.id,
        before_json: JSON.stringify({ ...sonnet, pricing: { prompt: 6 } }),
        record: sonnet,
      }),
    ),
  ).toBe("change");
  db.close();
});
