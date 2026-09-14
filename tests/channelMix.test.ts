import { expect, test } from "bun:test";
import { channelMix } from "../src/channelMix.js";
import type { Destination } from "../src/config.js";
import { prepareDeliveries } from "../src/events/batching.js";
import { saveCollection } from "../src/events/pipeline.js";
import type { Collection } from "../src/events/types.js";
import { openDatabase } from "../src/storage/database.js";

const wire: Destination = { id: "signals", platform: "discord", channelId: "1", signals: ["launch", "change"] };

test("the mix counts what each destination carried, not what it was subscribed to", () => {
  const db = openDatabase(":memory:");
  const catalogue: Collection = {
    source: "openai",
    stream: "api-models",
    url: "https://api.openai.com/models",
    raw: [],
    records: [{ id: "baseline", name: "Baseline", pricing: { prompt: "1" } }],
  };
  saveCollection(db, catalogue, [wire], "2026-09-10T10:00:00.000Z");
  catalogue.records.push({ id: "gpt-6-astra", name: "GPT-6 Astra" });
  saveCollection(db, catalogue, [wire], "2026-09-11T10:00:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-11T11:00:00.000Z"));
  db.query("UPDATE deliveries SET status='sent',updated_at='2026-09-11T11:00:00.000Z'").run();

  const report = channelMix(db, 7, Date.parse("2026-09-13T18:00:00.000Z"));
  expect(report.classes.find((entry) => entry.signal === "launch")).toMatchObject({ events: 1, delivered: 1 });
  expect(report.destinations).toEqual([{ id: "signals", sent: 1, failed: 0, withLead: 0, leadShare: 0 }]);
  expect(report.promotions).toEqual({ batches: 0, sent: 0 });
  db.close();
});

test("a delivery that failed for good stays visible in the mix", () => {
  const db = openDatabase(":memory:");
  const catalogue: Collection = {
    source: "openai",
    stream: "api-models",
    url: "https://api.openai.com/models",
    raw: [],
    records: [{ id: "baseline", name: "Baseline" }],
  };
  saveCollection(db, catalogue, [wire], "2026-09-10T10:00:00.000Z");
  catalogue.records.push({ id: "gpt-6-astra", name: "GPT-6 Astra" });
  saveCollection(db, catalogue, [wire], "2026-09-11T10:00:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-11T11:00:00.000Z"));
  db.query("UPDATE deliveries SET status='failed',updated_at='2026-09-11T11:00:00.000Z'").run();

  expect(channelMix(db, 7, Date.parse("2026-09-13T18:00:00.000Z")).destinations[0]).toMatchObject({
    sent: 0,
    failed: 1,
  });
  db.close();
});
