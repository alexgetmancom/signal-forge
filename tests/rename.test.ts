import { expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import { prepareDeliveries } from "../src/events/batching.js";
import { saveCollection } from "../src/events/pipeline.js";
import { renamedCounterpart } from "../src/events/rename.js";
import type { Collection, Event } from "../src/events/types.js";
import { openDatabase } from "../src/storage/database.js";

const wire: Destination = { id: "wire", platform: "discord", channelId: "1", signals: ["launch", "change"] };

function table(records: Collection["records"]): Collection {
  return {
    source: "deepseek-pricing",
    stream: "api-models",
    url: "https://api-docs.deepseek.com/quick_start/pricing/",
    raw: [],
    records,
  };
}

const pro = { modelVersion: "DeepSeek-V4-Pro-0813", pricing: { outputOffPeak: 1.98 } };
const flash = { modelVersion: "DeepSeek-V4-Flash-0731", pricing: { outputOffPeak: 0.66 } };

test("a re-keyed row is recognised by its body and says nothing twice", () => {
  const db = openDatabase(":memory:");
  saveCollection(
    db,
    table([
      { id: "deepseek-v4-pro", name: "deepseek-v4-pro", ...pro },
      { id: "deepseek-v4-flash", name: "deepseek-v4-flash", ...flash },
    ]),
    [wire],
    "2026-09-10T05:00:00.000Z",
  );
  // The catalogue re-keys: the same model under a numbered key, and a genuinely new model that
  // took over the old row's name with its own version and its own prices.
  saveCollection(
    db,
    table([
      { id: "deepseek-v4-pro (2)", name: "deepseek-v4-pro (2)", ...pro },
      {
        id: "deepseek-flash",
        name: "deepseek-flash",
        modelVersion: "DeepSeek-V4.1-Flash",
        pricing: { outputOffPeak: 0.6 },
      },
    ]),
    [wire],
    "2026-09-10T06:00:00.000Z",
  );
  // A record is missed twice before it is called gone, so the other half of the rename arrives a
  // poll later -- which is exactly what production saw, thirty minutes apart.
  saveCollection(
    db,
    table([
      { id: "deepseek-v4-pro (2)", name: "deepseek-v4-pro (2)", ...pro },
      {
        id: "deepseek-flash",
        name: "deepseek-flash",
        modelVersion: "DeepSeek-V4.1-Flash",
        pricing: { outputOffPeak: 0.6 },
      },
    ]),
    [wire],
    "2026-09-10T06:30:00.000Z",
  );

  const events = db.query<Event, []>("SELECT * FROM events ORDER BY id").all();
  const arrived = events.find((event) => event.entity_id === "deepseek-v4-pro (2)");
  const left = events.find((event) => event.entity_id === "deepseek-v4-pro");
  expect(renamedCounterpart(db, arrived as Event)?.entity_id).toBe("deepseek-v4-pro");
  expect(renamedCounterpart(db, left as Event)?.entity_id).toBe("deepseek-v4-pro (2)");
  // The real release wears a reused name and is left alone: its body says something different.
  const real = events.find((event) => event.entity_id === "deepseek-flash");
  expect(renamedCounterpart(db, real as Event)).toBe(null);

  prepareDeliveries(db, Date.parse("2026-09-10T07:00:00.000Z"));
  const reasons = db
    .query<{ entity_id: string; reason: string }, []>(
      "SELECT e.entity_id,s.reason FROM suppressions s JOIN events e ON e.id=s.event_id",
    )
    .all();
  expect(
    reasons
      .filter((row) => row.reason === "renamed_by_the_source")
      .map((row) => row.entity_id)
      .sort(),
  ).toEqual(["deepseek-v4-pro", "deepseek-v4-pro (2)"]);
  const body = db.query<{ body: string }, []>("SELECT body FROM deliveries").get()?.body ?? "";
  expect(body).toContain("DeepSeek Flash");
  expect(body).not.toContain("V4 Pro");
  db.close();
});
