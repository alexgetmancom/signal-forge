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
