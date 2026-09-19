import { expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { prepareDeliveries } from "../src/events/batching.js";
import { saveCollection } from "../src/events/pipeline.js";
import type { Collection } from "../src/events/types.js";
import { channelMix } from "../src/reports/channelMix.js";
import { openDatabase } from "../src/storage/database.js";

const base = loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname });
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

  const report = channelMix(db, { ...base, destinations: [wire] }, 7, Date.parse("2026-09-13T18:00:00.000Z"));
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

  expect(
    channelMix(db, { ...base, destinations: [wire] }, 7, Date.parse("2026-09-13T18:00:00.000Z")).destinations[0],
  ).toMatchObject({
    sent: 0,
    failed: 1,
  });
  db.close();
});

test("a class nobody subscribes to is counted as unrouted, not as nothing", () => {
  // An unsubscribed class creates no batch target, so it leaves no delivery and no suppression
  // either. Seven hours without a message on 2026-09-16 read as a broken collector and was this.
  const db = openDatabase(":memory:");
  const board: Collection = {
    source: "voxelbench",
    stream: "leaderboards",
    url: "https://voxelbench.example",
    raw: [],
    records: [{ id: "gpt-5-high", name: "GPT-5 High", rank: 1, score: 1700 }],
  };
  saveCollection(db, board, [wire], "2026-09-16T10:00:00.000Z");
  // Far enough for the board to mean it: a drift inside the implied interval is not a change.
  board.records = [{ id: "gpt-5-high", name: "GPT-5 High", rank: 1, score: 1650 }];
  saveCollection(db, board, [wire], "2026-09-16T11:00:00.000Z");

  const report = channelMix(db, { ...base, destinations: [wire] }, 7, Date.parse("2026-09-16T12:00:00.000Z"));
  expect(report.classes.find((entry) => entry.signal === "rank")).toMatchObject({
    events: 1,
    delivered: 0,
    routed: false,
    unrouted: 1,
  });
  db.close();
});

test("a shadow source is counted apart from a class nobody subscribes to", () => {
  // `codename` reported 7984 events and nothing unrouted while 7721 of them came from two
  // discovery collectors that are shadow and have no destination at all.
  const db = openDatabase(":memory:");
  const discovery: Collection = {
    source: "discovery:github-ai",
    stream: "github",
    url: "https://api.github.com",
    raw: [],
    records: [{ id: "anchor/one", name: "Anchor" }],
  };
  saveCollection(db, discovery, [], "2026-09-16T10:00:00.000Z");
  discovery.records.push({ id: "lab/new-agent", name: "New Agent" });
  saveCollection(db, discovery, [], "2026-09-16T11:00:00.000Z");

  const scouts: Destination = { id: "scouts", platform: "discord", channelId: "9", signals: ["codename"] };
  const report = channelMix(db, { ...base, destinations: [scouts] }, 7, Date.parse("2026-09-16T12:00:00.000Z"));
  expect(report.classes.find((entry) => entry.signal === "codename")).toMatchObject({
    events: 1,
    delivered: 0,
    routed: true,
    unrouted: 0,
    shadow: 1,
  });
  db.close();
});
