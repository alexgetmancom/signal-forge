import { expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { type Collection, prepareDeliveries, saveCollection } from "../src/events.js";
import { signalQuality } from "../src/signalQuality.js";
import { openDatabase } from "../src/storage/database.js";

const config = loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname });
const destination: Destination = { id: "dc", platform: "discord", channelId: "123", streams: ["openrouter"] };

const collection = (_at: string, records: Collection["records"]): Collection => ({
  source: "openrouter",
  stream: "openrouter",
  url: "https://openrouter.ai",
  raw: records,
  records,
});

test("signal quality reports collection outcomes, delivery modes and suppressed changes", () => {
  const db = openDatabase(":memory:");
  saveCollection(
    db,
    collection("2026-09-08T00:00:00.000Z", [{ id: "a", name: "A", pricing: { prompt: "1" } }]),
    [destination],
    "2026-09-08T00:00:00.000Z",
  );
  saveCollection(
    db,
    collection("2026-09-08T00:10:00.000Z", [{ id: "a", name: "A", pricing: { prompt: "2" } }]),
    [destination],
    "2026-09-08T00:10:00.000Z",
  );
  saveCollection(
    db,
    collection("2026-09-08T00:15:00.000Z", [
      { id: "a", name: "A", pricing: { prompt: "2" } },
      { id: "b", name: "B" },
    ]),
    [destination],
    "2026-09-08T00:15:00.000Z",
  );
  prepareDeliveries(db, Date.parse("2026-09-08T01:00:00.000Z"));
  saveCollection(
    db,
    collection("2026-09-08T02:00:00.000Z", [
      { id: "a", name: "A", pricing: { prompt: "2" }, updated: "2026-09-08T02:00:00.000Z" },
      { id: "b", name: "B" },
    ]),
    [destination],
    "2026-09-08T02:00:00.000Z",
  );
  prepareDeliveries(db, Date.parse("2026-09-08T03:00:00.000Z"));
  db.query(
    "INSERT INTO source_collection_metrics(source,collected_at,success,error) VALUES('openrouter','2026-09-08T00:30:00.000Z',0,'safe failure')",
  ).run();

  const report = signalQuality(db, config, 7, Date.parse("2026-09-09T00:00:00.000Z"));
  expect(report.coverage).toEqual({
    requestedSince: "2026-09-02T00:00:00.000Z",
    observedFrom: "2026-09-08T00:00:00.000Z",
    observedUntil: "2026-09-08T02:00:00.000Z",
    observedHours: 2,
  });
  const source = report.sources.find((entry) => entry.id === "openrouter");
  expect(source).toMatchObject({
    collections: 5,
    successfulCollections: 4,
    failedCollections: 1,
    recordsProcessed: 6,
    eventsCreated: 3,
    newEvents: 1,
    changedEvents: 2,
    removedEvents: 0,
    immediateDeliveries: 1,
    digestDeliveries: 1,
    failedDeliveries: 0,
    ambiguousDeliveries: 0,
    rolePings: 0,
    suppressedEvents: 1,
    sourceFailureRate: 0.2,
    averageEventsPerCollection: 0.75,
    storyCount: 2,
    uniqueStoryCount: 2,
    corroboratedStoryCount: 0,
    duplicateRate: 0,
    freshnessHours: 22,
  });
  db.close();
});

test("signal quality counts persisted role mentions without another schema table", () => {
  const db = openDatabase(":memory:");
  saveCollection(
    db,
    collection("2026-09-08T00:00:00.000Z", [{ id: "a", name: "A" }]),
    [destination],
    "2026-09-08T00:00:00.000Z",
  );
  saveCollection(
    db,
    collection("2026-09-08T00:10:00.000Z", [
      { id: "a", name: "A" },
      { id: "b", name: "B", maker: "OpenAI" },
    ]),
    [destination],
    "2026-09-08T00:10:00.000Z",
    { OpenAI: "role-openai" },
  );

  const source = signalQuality(db, config, 7, Date.parse("2026-09-09T00:00:00.000Z")).sources.find(
    (entry) => entry.id === "openrouter",
  );
  expect(source?.rolePings).toBe(1);
  db.close();
});

test("signal quality attributes a shared story digest to every contributing source", () => {
  const db = openDatabase(":memory:");
  const destinations: Destination[] = [
    { id: "dc", platform: "discord", channelId: "123", streams: ["openrouter", "api-models"] },
  ];
  const router: Collection = {
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai/models/gpt-5",
    raw: [],
    records: [{ id: "gpt-5", name: "GPT-5", maker: "OpenAI", pricing: { prompt: "1" } }],
  };
  const api: Collection = {
    source: "openai",
    stream: "api-models",
    url: "https://api.openai.com/models/gpt-5",
    raw: [],
    records: [{ id: "gpt-5", name: "GPT-5", maker: "OpenAI", context: 128000 }],
  };
  saveCollection(db, router, destinations, "2026-09-08T00:00:00Z");
  saveCollection(db, api, destinations, "2026-09-08T00:05:00Z");
  router.records = [{ id: "gpt-5", name: "GPT-5", maker: "OpenAI", pricing: { prompt: "2" } }];
  api.records = [{ id: "gpt-5", name: "GPT-5", maker: "OpenAI", context: 256000 }];
  saveCollection(db, router, destinations, "2026-09-08T01:00:00Z");
  saveCollection(db, api, destinations, "2026-09-08T01:05:00Z");
  prepareDeliveries(db, Date.parse("2026-09-08T02:00:00Z"));

  const report = signalQuality(db, { ...config, OPENAI_API_KEY: "test-key" }, 7, Date.parse("2026-09-08T02:00:00Z"));
  for (const id of ["openrouter", "openai"]) {
    expect(report.sources.find((source) => source.id === id)).toMatchObject({
      digestDeliveries: 1,
      storyCount: 1,
      uniqueStoryCount: 0,
      corroboratedStoryCount: 1,
      duplicateRate: 1,
    });
  }
  expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM deliveries").get()).toEqual({ count: 1 });
  db.close();
});

test("signal quality counts a shared digest only for subscribed streams", () => {
  const db = openDatabase(":memory:");
  const destinations: Destination[] = [
    { id: "models", platform: "discord", channelId: "123", streams: ["openrouter"] },
    { id: "benchmarks", platform: "discord", channelId: "456", streams: ["leaderboards"] },
  ];
  const router: Collection = {
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai/models",
    raw: [],
    records: [{ id: "router-model", name: "Router model", pricing: { prompt: "1" } }],
  };
  const leaderboard: Collection = {
    source: "arena-leaderboards",
    stream: "leaderboards",
    url: "https://arena.ai/leaderboard",
    raw: [],
    records: [{ id: "leaderboard-model", name: "Leaderboard model", rank: 2, score: 1 }],
  };
  saveCollection(db, router, destinations, "2026-09-08T09:00:00Z");
  saveCollection(db, leaderboard, destinations, "2026-09-08T09:05:00Z");
  router.records = [{ id: "router-model", name: "Router model", pricing: { prompt: "2" } }];
  leaderboard.records = [{ id: "leaderboard-model", name: "Leaderboard model", rank: 1, score: 2 }];
  saveCollection(db, router, destinations, "2026-09-08T10:00:00Z");
  saveCollection(db, leaderboard, destinations, "2026-09-08T10:05:00Z");
  prepareDeliveries(db, Date.parse("2026-09-08T11:00:00Z"));

  const report = signalQuality(db, config, 7, Date.parse("2026-09-08T12:00:00Z"));
  expect(report.sources.find((source) => source.id === "openrouter")).toMatchObject({ digestDeliveries: 1 });
  expect(report.sources.find((source) => source.id === "arena-leaderboards")).toMatchObject({ digestDeliveries: 1 });
  db.close();
});

test("signal quality measures independent first signals, confirmed lead time and shadow density", () => {
  const db = openDatabase(":memory:");
  const measuredConfig = {
    ...config,
    OPENAI_API_KEY: "test-openai-key",
    GITHUB_TOKEN: "test-github-token",
  };
  const modelOne = { id: "openai/model-one", name: "Model One", maker: "OpenAI" };
  const modelTwo = { id: "openai/model-two", name: "Model Two", maker: "OpenAI" };
  const make = (source: string, stream: Collection["stream"], records: Collection["records"]): Collection => ({
    source,
    stream,
    url: `https://example.test/${source}`,
    raw: records,
    appendOnly: true,
    records,
  });
  saveCollection(db, make("openrouter", "openrouter", []), [], "2026-09-10T08:59:00Z");
  saveCollection(db, make("openrouter", "openrouter", [modelOne]), [], "2026-09-10T09:00:00Z");
  saveCollection(db, make("discovery:github-ai", "github", []), [], "2026-09-10T09:29:00Z");
  saveCollection(
    db,
    make("discovery:github-ai", "github", [{ id: "openai/model-one", name: "openai/model-one", owner: "openai" }]),
    [],
    "2026-09-10T09:30:00Z",
  );
  saveCollection(db, make("openai-news", "news", []), [], "2026-09-10T09:44:00Z");
  saveCollection(
    db,
    make("openai-news", "news", [{ id: "model-one-news", name: "Model One", maker: "OpenAI" }]),
    [],
    "2026-09-10T09:45:00Z",
  );
  saveCollection(db, make("openai", "api-models", []), [], "2026-09-10T09:59:00Z");
  saveCollection(db, make("openai", "api-models", [modelOne]), [], "2026-09-10T10:00:00Z");
  saveCollection(db, make("openrouter", "openrouter", [modelOne, modelTwo]), [], "2026-09-10T11:00:00Z");
  saveCollection(db, make("openai", "api-models", [modelOne, modelTwo]), [], "2026-09-10T12:30:00Z");

  const report = signalQuality(db, measuredConfig, 7, Date.parse("2026-09-10T13:00:00Z"));
  const openrouter = report.sources.find((source) => source.id === "openrouter");
  expect(openrouter).toMatchObject({
    eventsCreated: 2,
    recordsProcessed: 3,
    signalDensity: 0.667,
    firstSourceWins: 2,
    laterConfirmed: 2,
    confirmationRate: 1,
    medianLeadTimeSeconds: 4500,
  });
  const discovery = report.sources.find((source) => source.id === "discovery:github-ai");
  expect(discovery).toMatchObject({ mode: "shadow", eventsCreated: 1, signalDensity: 1 });
  db.close();
});
