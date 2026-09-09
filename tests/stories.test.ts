import { expect, test } from "bun:test";
import { confidenceFor } from "../src/events/confidence.js";
import { identityFor } from "../src/events/identity.js";
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

test("identity keeps Arena codenames unresolved until a canonical source identifies them", () => {
  const leaderboard = identityFor(
    {
      id: 1,
      source: "arena-leaderboards",
      stream: "leaderboards",
      entity_id: "text:overall:secret-key",
      kind: "new",
      before_json: null,
      after_json: null,
      detected_at: "2026-09-08T00:00:00.000Z",
    },
    { id: "text:overall:secret-key", name: "GPT-6 preview", modelKey: "secret-key" },
  );
  expect(leaderboard).toMatchObject({
    canonicalId: null,
    status: "codename",
    aliases: ["secret-key", "GPT-6 preview"],
  });

  const catalogue = identityFor(
    {
      id: 2,
      source: "openrouter",
      stream: "openrouter",
      entity_id: "openai/gpt-6",
      kind: "new",
      before_json: null,
      after_json: null,
      detected_at: "2026-09-08T00:00:00.000Z",
    },
    { id: "openai/gpt-6", name: "GPT-6", maker: "OpenAI" },
  );
  expect(catalogue).toMatchObject({ canonicalId: "openai/gpt-6", status: "canonical", aliases: ["GPT-6"] });
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
    canonicalId: "gpt-5",
    identityStatus: "canonical",
    confidence: "confirmed",
    currentStatus: "active",
    sources: ["openrouter", "openai"],
    eventIds: [1, 2],
  });
  expect(listStories(db, { minConfidence: "confirmed", limit: 10 })[0]?.id).toBe(stories[0]?.id);
  expect(db.query("SELECT id,source,confidence FROM events ORDER BY id").all()).toEqual(original);
  const writesBeforeRead = db.query<{ changes: number }, []>("SELECT total_changes() AS changes").get()?.changes;
  listStories(db, { limit: 10 });
  const writesAfterRead = db.query<{ changes: number }, []>("SELECT total_changes() AS changes").get()?.changes;
  expect(writesAfterRead).toBe(writesBeforeRead);
  db.close();
});

test("GitHub repository events stay separate unless their entity identity is the same", () => {
  const db = openDatabase(":memory:");
  const github = (source: string, records: Collection["records"]): Collection => ({
    ...collection(source, "github", records),
    appendOnly: true,
    trackChanges: true,
  });
  saveCollection(
    db,
    github("github:openai/codex:commits", [{ id: "sha-1", name: "Auth cleanup" }]),
    [],
    "2026-09-08T00:00:00.000Z",
  );
  saveCollection(
    db,
    github("github:openai/codex:pulls", [{ id: "42", name: "#42 Auth cleanup" }]),
    [],
    "2026-09-08T00:01:00.000Z",
  );
  saveCollection(
    db,
    github("github:openai/codex:releases", [{ id: "100", name: "v0.50.0" }]),
    [],
    "2026-09-08T00:02:00.000Z",
  );
  saveCollection(
    db,
    github("github:openai/codex:commits", [
      { id: "sha-1", name: "Auth cleanup" },
      { id: "sha-2", name: "Terminal changes" },
    ]),
    [],
    "2026-09-08T00:03:00.000Z",
  );
  saveCollection(
    db,
    github("github:openai/codex:pulls", [
      { id: "42", name: "#42 Auth cleanup" },
      { id: "43", name: "#43 Windows support" },
    ]),
    [],
    "2026-09-08T00:04:00.000Z",
  );
  saveCollection(
    db,
    github("github:openai/codex:releases", [
      { id: "100", name: "v0.50.0" },
      { id: "101", name: "v0.51.0" },
    ]),
    [],
    "2026-09-08T00:05:00.000Z",
  );

  const stories = listStories(db, { vendor: "OpenAI", limit: 20 });
  expect(stories).toHaveLength(3);
  expect(stories.every((story) => story.eventIds.length === 1)).toBe(true);
  expect(stories.find((story) => story.sources[0]?.endsWith(":releases"))).toMatchObject({ confidence: "shipped" });
  expect(
    stories.filter((story) => story.sources[0]?.endsWith(":commits")).every((story) => story.confidence === "observed"),
  ).toBe(true);
  db.close();
});
