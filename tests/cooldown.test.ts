import { expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import { type Collection, prepareDeliveries, saveCollection } from "../src/events.js";
import { openDatabase } from "../src/storage/database.js";

const destination: Destination = { id: "changes", platform: "discord", channelId: "1", signals: ["change"] };

const catalogue = (price: string): Collection => ({
  source: "openrouter",
  stream: "openrouter",
  url: "https://openrouter.ai/models",
  raw: [],
  records: [{ id: "moonshotai/kimi-k3", name: "MoonshotAI: Kimi K3", pricing: { completion: price } }],
});

/** Renders the cards a destination would receive, newest last. */
function cards(db: ReturnType<typeof openDatabase>): string[] {
  return db
    .query<{ body: string }, []>("SELECT body FROM deliveries ORDER BY id")
    .all()
    .flatMap((row) => {
      const payload = JSON.parse(row.body) as { embeds?: { description?: string }[] };
      return (payload.embeds ?? []).map((embed) => embed.description ?? "");
    });
}

test("a price that slides all day is one message about the whole slide, not six about each step", () => {
  const db = openDatabase(":memory:");
  const hour = 3_600_000;
  const start = Date.parse("2026-09-11T01:00:00.000Z");
  // $15 → $13 → $11.70 → $10.53 → $9.48, one step an hour, exactly as Kimi K3 moved.
  const steps = ["0.000015", "0.000013", "0.0000117", "0.00001053", "0.00000948"];
  steps.forEach((price, index) => {
    saveCollection(db, catalogue(price), [destination], new Date(start + index * hour).toISOString());
    prepareDeliveries(db, start + index * hour + hour / 2);
  });

  const delivered = cards(db);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toContain("$15 → $13 / 1M tokens");
  db.close();
});

test("once the wait is over the card covers the whole move, not the last step", () => {
  const db = openDatabase(":memory:");
  const hour = 3_600_000;
  const start = Date.parse("2026-09-11T01:00:00.000Z");
  const steps = ["0.000015", "0.000013", "0.0000117", "0.00001053", "0.00000948"];
  steps.forEach((price, index) => {
    saveCollection(db, catalogue(price), [destination], new Date(start + index * hour).toISOString());
    prepareDeliveries(db, start + index * hour + hour / 2);
  });
  // Seven hours after the first message the wait is over and the held drift can speak.
  prepareDeliveries(db, start + 7 * hour);

  const delivered = cards(db);
  expect(delivered).toHaveLength(2);
  // The reader last saw $13 and the price is now $9.48. The steps in between are in the database,
  // not in the message: one card covers the whole move that reader missed.
  expect(delivered[1]).toContain("$13 → $9.48 / 1M tokens");
  expect(delivered[1]).not.toContain("$11.7");
  db.close();
});

test("a move that returns to the state a destination last saw says nothing", () => {
  const db = openDatabase(":memory:");
  const hour = 3_600_000;
  const start = Date.parse("2026-09-11T01:00:00.000Z");
  saveCollection(db, catalogue("0.000015"), [destination], new Date(start).toISOString());
  saveCollection(db, catalogue("0.000013"), [destination], new Date(start + hour).toISOString());
  prepareDeliveries(db, start + 2 * hour);
  expect(cards(db)).toHaveLength(1);

  // Seven hours later it is back where the reader last saw it.
  const later = start + 8 * hour;
  saveCollection(db, catalogue("0.000015"), [destination], new Date(later).toISOString());
  prepareDeliveries(db, later + hour / 2);
  expect(cards(db)).toHaveLength(1);
  db.close();
});

test("a first change for a subject never waits", () => {
  const db = openDatabase(":memory:");
  const start = Date.parse("2026-09-11T01:00:00.000Z");
  saveCollection(db, catalogue("0.000015"), [destination], new Date(start).toISOString());
  saveCollection(db, catalogue("0.000013"), [destination], new Date(start + 3_600_000).toISOString());
  prepareDeliveries(db, start + 2 * 3_600_000);
  expect(cards(db)).toHaveLength(1);
  db.close();
});

test("steps too small to report on their own add up to one card", () => {
  const db = openDatabase(":memory:");
  const hour = 3_600_000;
  const start = Date.parse("2026-09-11T01:00:00.000Z");
  // $1.896 → $1.720 → $1.630 → $1.560: −9.3%, −5.2% and −4.3%, every step under the ten percent
  // that makes a price worth reporting, and −17.7% together.
  const steps = ["0.000001896", "0.00000172", "0.00000163", "0.00000156"];
  steps.forEach((price, index) => {
    saveCollection(db, catalogue(price), [destination], new Date(start + index * hour).toISOString());
    prepareDeliveries(db, start + (index + 1) * hour);
  });

  const delivered = cards(db);
  expect(delivered).toHaveLength(1);
  // It speaks as soon as the accumulated drift crosses the line, and the card covers the whole
  // drift rather than the small step that happened to cross it.
  expect(delivered[0]).toContain("$1.9 → $1.63 / 1M tokens");
  db.close();
});
