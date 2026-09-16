import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { saveCollection } from "../src/events/pipeline.js";
import type { Collection } from "../src/events/types.js";
import { sourceVerdicts } from "../src/sourceVerdicts.js";
import { openDatabase } from "../src/storage/database.js";
import { updateStories } from "../src/stories.js";

test("a source that never led, never reached a reader and drew no votes is named", () => {
  const db = openDatabase(":memory:");
  const config = loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname });
  const catalogue = (source: string, stream: string, ids: string[]): Collection => ({
    source,
    stream,
    url: `https://${source}.example`,
    raw: [],
    records: ids.map((id) => ({ id, name: id })),
  });
  // Both collect from the start of the period; OpenRouter lists the model a day before OpenAI.
  saveCollection(db, catalogue("openrouter", "openrouter", ["anchor"]), [], "2026-08-01T00:00:00.000Z");
  saveCollection(db, catalogue("openai", "api-models", ["anchor"]), [], "2026-08-01T00:00:00.000Z");
  saveCollection(db, catalogue("openrouter", "openrouter", ["anchor", "gpt-live-1"]), [], "2026-09-09T00:00:00.000Z");
  saveCollection(db, catalogue("openai", "api-models", ["anchor", "gpt-live-1"]), [], "2026-09-10T00:00:00.000Z");
  updateStories(db);

  const report = sourceVerdicts(db, config, 30, Date.parse("2026-09-16T00:00:00.000Z"));
  const verdict = (source: string) => report.sources.find((row) => row.source === source);
  expect(verdict("openrouter")).toMatchObject({ ledOthers: 1, verdict: "earning" });
  expect(verdict("openai")).toMatchObject({
    ledOthers: 0,
    delivered: 0,
    scoutVotes: 0,
    verdict: "no_measurable_value",
  });
  // A source that has not collected for the whole period is not judged at all.
  expect(verdict("anthropic")).toBeUndefined();
  db.close();
});
