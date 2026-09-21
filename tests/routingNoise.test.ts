import { expect, test } from "bun:test";
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

test("a reseller's serving mode of a known model is not a new model", () => {
  const row = { source: "dashscope", stream: "api-models" };
  expect(signalClass(event({ ...row, entity_id: "glm-5.3-prime", record: { id: "glm-5.3-prime" } }))).toBe("evidence");
  expect(signalClass(event({ ...row, entity_id: "glm-5.4", record: { id: "glm-5.4" } }))).toBe("codename");
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
  db.close();
});
