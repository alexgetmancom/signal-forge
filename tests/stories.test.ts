import { expect, test } from "bun:test";
import { confidenceFor } from "../src/events/confidence.js";
import { type Collection, saveCollection } from "../src/events.js";
import { openDatabase } from "../src/storage/database.js";
import { listStories } from "../src/stories.js";

const collection = (source: string, stream: string, records: Collection["records"]): Collection => ({
  source,
  stream,
  url: "https://example.test",
  raw: records,
  records,
});

test("confidence labels follow source semantics instead of presentation guesses", () => {
  expect(confidenceFor("arena", "arena")).toBe("observed");
  expect(confidenceFor("openai", "api-models")).toBe("confirmed");
  expect(confidenceFor("openai-news", "news")).toBe("supported");
  expect(confidenceFor("github:openai/codex:releases", "github")).toBe("shipped");
});

test("stories correlate evidence without rewriting the original events", () => {
  const db = openDatabase(":memory:");
  saveCollection(
    db,
    collection("openrouter", "openrouter", [{ id: "gpt-5", name: "GPT-5", pricing: { prompt: "1" } }]),
    [],
    "2026-09-08T00:00:00.000Z",
  );
  saveCollection(
    db,
    collection("openrouter", "openrouter", [{ id: "gpt-5", name: "GPT-5", pricing: { prompt: "2" } }]),
    [],
    "2026-09-08T00:05:00.000Z",
  );
  saveCollection(
    db,
    collection("openai", "api-models", [{ id: "gpt-5", name: "GPT-5", context: 100 }]),
    [],
    "2026-09-08T00:00:00.000Z",
  );
  saveCollection(
    db,
    collection("openai", "api-models", [{ id: "gpt-5", name: "GPT-5", context: 200 }]),
    [],
    "2026-09-08T00:10:00.000Z",
  );
  const original = db.query("SELECT id,source,confidence FROM events ORDER BY id").all();
  const stories = listStories(db, { minConfidence: "confirmed", limit: 10 });
  expect(stories).toHaveLength(1);
  expect(stories[0]).toMatchObject({
    vendor: "OpenAI",
    confidence: "confirmed",
    currentStatus: "active",
    sources: ["openrouter", "openai"],
    eventIds: [1, 2],
  });
  expect(listStories(db, { minConfidence: "confirmed", limit: 10 })[0]?.id).toBe(stories[0]?.id);
  expect(db.query("SELECT id,source,confidence FROM events ORDER BY id").all()).toEqual(original);
  db.close();
});
