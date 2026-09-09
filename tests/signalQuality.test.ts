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
    undefined,
    { OpenAI: "role-openai" },
  );

  const source = signalQuality(db, config, 7, Date.parse("2026-09-09T00:00:00.000Z")).sources.find(
    (entry) => entry.id === "openrouter",
  );
  expect(source?.rolePings).toBe(1);
  db.close();
});
