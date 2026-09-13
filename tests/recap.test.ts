import { expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import { prepareDeliveries } from "../src/events/batching.js";
import { saveCollection } from "../src/events/pipeline.js";
import type { Collection } from "../src/events/types.js";
import { lastRecapPeriod, scheduleWeeklyRecap, weeklyRecapContext } from "../src/recap.js";
import { openDatabase } from "../src/storage/database.js";

const wire: Destination = { id: "wire", platform: "discord", channelId: "1", signals: ["launch", "change"] };
const config = { destinations: [wire] } as never;

test("a recap covers the week that ended on the most recent Sunday evening", () => {
  // Wednesday: the last complete week ended on Sunday the 13th.
  expect(lastRecapPeriod(Date.parse("2026-09-16T09:00:00.000Z"))).toBe("2026-09-13T18:00:00.000Z");
  // Sunday morning, before the hour: the week that ended is the one before.
  expect(lastRecapPeriod(Date.parse("2026-09-13T09:00:00.000Z"))).toBe("2026-09-06T18:00:00.000Z");
});

function week(db: ReturnType<typeof openDatabase>) {
  const catalogue: Collection = {
    source: "openai",
    stream: "api-models",
    url: "https://api.openai.com/models",
    raw: [],
    records: [{ id: "baseline", name: "Baseline", pricing: { prompt: "1" } }],
  };
  saveCollection(db, catalogue, [wire], "2026-09-08T10:00:00.000Z");
  catalogue.records.push({ id: "gpt-6-astra", name: "GPT-6 Astra" });
  saveCollection(db, catalogue, [wire], "2026-09-09T10:00:00.000Z");
  catalogue.records[0] = { id: "baseline", name: "Baseline", pricing: { prompt: "0.4" } };
  saveCollection(db, catalogue, [wire], "2026-09-10T10:00:00.000Z");
}

test("the week reads back as what arrived and what moved furthest", () => {
  const db = openDatabase(":memory:");
  week(db);
  const context = weeklyRecapContext(db, "2026-09-13T18:00:00.000Z");
  expect(context.arrivals).toContain("GPT-6 Astra");
  expect(context.arrivalCount).toBe(1);
  expect(context.priceMoves[0]).toMatchObject({ name: "Baseline", cheaper: true });
  expect(Math.round((context.priceMoves[0]?.percent ?? 0) * 100)).toBe(60);
});

test("early sightings are counted as subjects, not as observations", () => {
  const db = openDatabase(":memory:");
  const arena: Collection = {
    source: "arena",
    stream: "arena",
    url: "https://arena.example",
    raw: [],
    records: [{ id: "baseline", name: "Baseline" }],
  };
  saveCollection(db, arena, [wire], "2026-09-08T00:00:00.000Z");
  // The same entry, seen again and again all week, is one thing the scouts saw.
  for (const [index, at] of ["2026-09-09", "2026-09-10", "2026-09-11"].entries()) {
    arena.records[1] = { id: "spicy-mayo", name: "spicy-mayo", rank: index + 1 };
    saveCollection(db, arena, [wire], `${at}T00:00:00.000Z`);
  }
  expect(weeklyRecapContext(db, "2026-09-13T18:00:00.000Z").codenameCount).toBe(1);
});

test("the recap is queued once for a period and never twice", () => {
  const db = openDatabase(":memory:");
  week(db);
  const now = Date.parse("2026-09-14T09:00:00.000Z");
  expect(scheduleWeeklyRecap(db, config, now)).toBe(true);
  expect(scheduleWeeklyRecap(db, config, now)).toBe(false);
  expect(db.query("SELECT COUNT(*) AS n FROM batches WHERE kind='weekly_recap'").get()).toEqual({ n: 1 });

  prepareDeliveries(db, now);
  const body = db
    .query<{ body: string }, [string]>("SELECT body FROM deliveries d JOIN batches b ON b.id=d.batch_id WHERE b.kind=?")
    .get("weekly_recap")?.body;
  expect(body).toContain("1 model arrived");
  expect(body).toContain("GPT-6 Astra");
});

test("a week with nothing in it is not a message", () => {
  const db = openDatabase(":memory:");
  expect(scheduleWeeklyRecap(db, config, Date.parse("2026-09-14T09:00:00.000Z"))).toBe(false);
});
