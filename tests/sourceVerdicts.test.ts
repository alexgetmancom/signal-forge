import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { saveCollection } from "../src/events/pipeline.js";
import type { Collection } from "../src/events/types.js";
import { sourceVerdicts } from "../src/reports/sourceVerdicts.js";
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
  // OpenAI never led and reached nobody, but it saw what OpenRouter saw: the value is there and
  // the routing is not carrying it. Judged on delivery alone it would read as worthless.
  expect(verdict("openai")).toMatchObject({
    ledOthers: 0,
    delivered: 0,
    scoutVotes: 0,
    events: 1,
    arrivals: 1,
    corroborated: 1,
    heldBack: 1,
    verdict: "held_back",
  });
  // A source that has not collected for the whole period is not judged at all.
  expect(verdict("anthropic")).toBeUndefined();
  expect(report.notYetJudged).toContainEqual({ source: "anthropic", collectingSince: null });
  db.close();
});

test("a source whose events nobody else saw and nobody received has no measurable value", () => {
  const db = openDatabase(":memory:");
  const config = loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname });
  const catalogue = (source: string, stream: string, ids: string[]): Collection => ({
    source,
    stream,
    url: `https://${source}.example`,
    raw: [],
    records: ids.map((id) => ({ id, name: id })),
  });
  saveCollection(db, catalogue("openrouter", "openrouter", ["anchor"]), [], "2026-08-01T00:00:00.000Z");
  saveCollection(db, catalogue("openai", "api-models", ["anchor"]), [], "2026-08-01T00:00:00.000Z");
  saveCollection(
    db,
    catalogue("openrouter", "openrouter", ["anchor", "promo-bundle-alpha"]),
    [],
    "2026-09-09T00:00:00.000Z",
  );
  saveCollection(db, catalogue("openai", "api-models", ["anchor"]), [], "2026-09-10T00:00:00.000Z");
  updateStories(db);

  const report = sourceVerdicts(db, config, 30, Date.parse("2026-09-16T00:00:00.000Z"));
  expect(report.sources.find((row) => row.source === "openrouter")).toMatchObject({
    events: 1,
    corroborated: 0,
    corroborationRate: 0,
    heldBack: 0,
    verdict: "no_measurable_value",
  });
  // Recording nothing is the opposite verdict from recording plenty that reached nobody: the first
  // is a deprecation feed with nothing to report, and reading it as waste is what made this list
  // look like a kill list.
  expect(report.sources.find((row) => row.source === "openai")).toMatchObject({
    events: 0,
    verdict: "quiet_sentinel",
  });

  // A source too young to judge still shows its numbers while the trial runs.
  expect(report.preliminary.every((row) => report.notYetJudged.some((young) => young.source === row.source))).toBe(
    true,
  );
  db.close();
});

test("a number that moved on a model others carry is not corroboration", () => {
  const db = openDatabase(":memory:");
  const config = loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname });
  const catalogue = (
    source: string,
    stream: string,
    records: { id: string; name: string; created?: number }[],
  ): Collection => ({
    source,
    stream,
    url: `https://${source}.example`,
    raw: [],
    records,
  });
  saveCollection(
    db,
    catalogue("openrouter", "openrouter", [{ id: "kimi-k3", name: "kimi-k3" }]),
    [],
    "2026-08-01T00:00:00.000Z",
  );
  saveCollection(
    db,
    catalogue("moonshot", "api-models", [{ id: "kimi-k3", name: "kimi-k3", created: 1 }]),
    [],
    "2026-08-01T00:00:00.000Z",
  );
  // Moonshot stamps the poll time into `created`: a change nobody else could have seen.
  saveCollection(
    db,
    catalogue("moonshot", "api-models", [{ id: "kimi-k3", name: "kimi-k3", created: 2 }]),
    [],
    "2026-09-10T00:00:00.000Z",
  );
  updateStories(db);

  const row = sourceVerdicts(db, config, 30, Date.parse("2026-09-16T00:00:00.000Z")).sources.find(
    (verdict) => verdict.source === "moonshot",
  );
  // The moved number never even becomes an event, so the source recorded nothing in the period:
  // quiet, which is a different thing from producing output nobody wanted.
  expect(row).toMatchObject({ events: 0, arrivals: 0, corroborated: 0, heldBack: 0, verdict: "quiet_sentinel" });
  db.close();
});

test("a source that writes into the morning recap is earning, though it never sent a card", () => {
  const db = openDatabase(":memory:");
  db.exec("INSERT INTO snapshots(id,source,collected_at) VALUES(1,'x','2026-09-01T00:00:00.000Z')");
  db.query(
    `INSERT INTO events(id,source,stream,entity_id,kind,after_json,detected_at,snapshot_id,confidence,evidence_type,authority)
     VALUES(1,'github:openai/codex:commits','repos','c1','new','{}','2026-09-20T00:00:00.000Z',1,'observed','status_page','first_party')`,
  ).run();
  db.query("INSERT INTO summaries(event_id,text,created_at) VALUES(1,'A line for the recap.',?)").run(
    "2026-09-20T01:00:00.000Z",
  );
  const config = loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname });
  const report = sourceVerdicts(db, config, 30, Date.parse("2026-09-24T00:00:00.000Z"));
  const row = [...report.sources, ...report.preliminary].find(
    (entry) => entry.source === "github:openai/codex:commits",
  );
  expect(row?.recapLines).toBe(1);
  expect(row?.verdict).toBe("earning");
});
