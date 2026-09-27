import { expect, test } from "bun:test";
import { unknownMakers } from "../src/reports/unknownMakers.js";
import { openDatabase } from "../src/storage/database.js";
import { anEvent } from "./fixtures/build.js";

const NOW = Date.parse("2026-09-27T00:00:00.000Z");
const listing = (source: string, stream: string, name: string, extra: Record<string, unknown> = {}) => ({
  source,
  stream,
  entityId: name,
  afterJson: JSON.stringify({ id: name, name, ...extra }),
  detectedAt: "2026-09-25T00:00:00.000Z",
});

test("an unplaced maker is ranked by independent sources, and a maker the table already knows is absent", () => {
  const db = openDatabase(":memory:");
  // One laboratory three catalogues listed, one nickname a single catalogue listed, and a model
  // whose maker the vendor table already places.
  anEvent(db, listing("models-dev", "api-models", "AI21: Jamba Large"));
  anEvent(db, listing("openrouter", "openrouter", "AI21: Jamba Mini"));
  anEvent(db, listing("huggingface-router", "weights", "ai21/jamba-reasoning"));
  anEvent(db, listing("models-dev", "api-models", "well9472/some-merge"));
  anEvent(db, listing("models-dev", "api-models", "Claude Opus 5"));

  const report = unknownMakers(db, 30, 40, NOW);
  const handles = report.makers.map((maker) => maker.handle);
  expect(handles).toEqual(["ai21", "well9472"]);
  expect(report.makers[0]?.independentSourceCount).toBe(3);
  expect(report.makers[0]?.names).toEqual(["AI21: Jamba Large", "AI21: Jamba Mini", "ai21/jamba-reasoning"]);
  expect(report.makers[1]?.independentSourceCount).toBe(1);
  expect(report.unplacedEvents).toBe(4);
});

test("a maker named only in the record's maker field is placed, and a stream that is not a catalogue is not read", () => {
  const db = openDatabase(":memory:");
  anEvent(db, listing("models-dev", "api-models", "Command A+", { maker: "cohere" }));
  anEvent(db, listing("openai-news", "news", "Some Unplaceable Headline"));

  expect(unknownMakers(db, 30, 40, NOW).makers).toEqual([]);
});

test("a listing older than the window is not read", () => {
  const db = openDatabase(":memory:");
  anEvent(db, { ...listing("models-dev", "api-models", "Toast 1"), detectedAt: "2026-07-01T00:00:00.000Z" });

  expect(unknownMakers(db, 30, 40, NOW).makers).toEqual([]);
});
