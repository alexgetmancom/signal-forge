import { expect, test } from "bun:test";
import { saveCollection } from "../src/events/pipeline.js";
import { renderRecapLines } from "../src/events/render/lifecycle.js";
import { signalClass } from "../src/events/signals.js";
import type { Event } from "../src/events/types.js";
import { lastRecapPeriod, recapContext } from "../src/recap.js";
import { collectArtificialAnalysis } from "../src/sources/analysis.js";
import { openDatabase } from "../src/storage/database.js";

const model = (id: string, index: number | null) => ({
  id,
  name: id,
  model_creator: { name: "Lab" },
  evaluations: { artificial_analysis_intelligence_index: index },
});
const read = (models: unknown[]) =>
  collectArtificialAnalysis({ ARTIFICIAL_ANALYSIS_API_KEY: "key" } as never, async () =>
    Response.json({ data: models }),
  );

test("the Intelligence Index is given places, and only the leading twenty carry one", async () => {
  const many = Array.from({ length: 25 }, (_, index) => model(`m${index}`, 100 - index));
  const collection = await read([...many, model("unscored", null)]);
  const place = new Map(collection.records.map((record) => [record.id, record.rank]));
  expect(place.get("m0")).toBe(1);
  expect(place.get("m19")).toBe(20);
  expect(place.get("m20")).toBeUndefined();
  expect(place.get("unscored")).toBeUndefined();
});

test("a model new to the Index debuts on the wire in the top ten and is named to the scouts wherever it lands", async () => {
  const db = openDatabase(":memory:");
  const base = Array.from({ length: 12 }, (_, index) => model(`m${index}`, 60 - index));
  saveCollection(db, await read(base), [], "2026-09-15T00:00:00.000Z");
  saveCollection(
    db,
    await read([...base, model("Frontier 2", 70), model("Small 1", 20)]),
    [],
    "2026-09-16T12:00:00.000Z",
  );
  const arrivals = db
    .query<Event, []>("SELECT * FROM events WHERE kind='new' ORDER BY id")
    .all()
    .map((event) => [event.entity_id, signalClass(event)]);
  // Both were measured, so both are sightings; only the top ten goes to the public wire.
  expect(arrivals).toEqual([
    ["Frontier 2", "debut"],
    ["Small 1", "codename"],
  ]);
  const context = recapContext(db, lastRecapPeriod(Date.parse("2026-09-17T07:00:00.000Z"), "day"), "day");
  const scouts = renderRecapLines(context, ["codename"]).join("\n");
  expect(scouts).toContain("🧠 Frontier 2 scored 70.0 on the Intelligence Index · #1");
  expect(scouts).toContain("🧠 Small 1 scored 20.0 on the Intelligence Index");
  // Places added to rows that already had none are not a new leader.
  expect(scouts).not.toContain("now leads");
  db.close();
});
