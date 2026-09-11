import { expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import { type Collection, prepareDeliveries, saveCollection } from "../src/events.js";
import { openDatabase } from "../src/storage/database.js";

const destination: Destination = { id: "changes", platform: "discord", channelId: "1", signals: ["change"] };

const catalogue = (completion: string): Collection => ({
  source: "openrouter",
  stream: "openrouter",
  url: "https://openrouter.ai/models",
  raw: [],
  records: [{ id: "deepseek/v4-pro", name: "DeepSeek: V4 Pro", pricing: { completion } }],
});

type Row = { reason: string; detail: string; destination_id: string };

function suppressions(db: ReturnType<typeof openDatabase>): Row[] {
  return db.query<Row, []>("SELECT reason,detail,destination_id FROM suppressions ORDER BY event_id").all();
}

test("a price move under the threshold says in writing why it stayed quiet", () => {
  const db = openDatabase(":memory:");
  const start = Date.parse("2026-09-11T01:00:00.000Z");
  // $1.896 → $1.720 per million: the real DeepSeek V4 Pro move that produced an empty digest.
  saveCollection(db, catalogue("0.000001896"), [destination], new Date(start).toISOString());
  saveCollection(db, catalogue("0.00000172"), [destination], new Date(start + 3_600_000).toISOString());
  prepareDeliveries(db, start + 2 * 3_600_000);

  expect(db.query<{ c: number }, []>("SELECT COUNT(*) c FROM deliveries").get()?.c).toBe(0);
  const recorded = suppressions(db);
  expect(recorded).toHaveLength(1);
  expect(recorded[0]?.reason).toBe("no_reader_facing_change");
  expect(recorded[0]?.detail).toBe("Price moved 9.3%, under the 10% threshold");
  expect(recorded[0]?.destination_id).toBe("changes");
  db.close();
});

test("an event that speaks leaves no suppression behind", () => {
  const db = openDatabase(":memory:");
  const start = Date.parse("2026-09-11T01:00:00.000Z");
  saveCollection(db, catalogue("0.000015"), [destination], new Date(start).toISOString());
  saveCollection(db, catalogue("0.000005"), [destination], new Date(start + 3_600_000).toISOString());
  prepareDeliveries(db, start + 2 * 3_600_000);

  expect(db.query<{ c: number }, []>("SELECT COUNT(*) c FROM deliveries").get()?.c).toBeGreaterThan(0);
  expect(suppressions(db)).toHaveLength(0);
  db.close();
});

test("a held move records the wait and names the destination that is already caught up", () => {
  const db = openDatabase(":memory:");
  const hour = 3_600_000;
  const start = Date.parse("2026-09-11T01:00:00.000Z");
  const steps = ["0.000015", "0.000013", "0.0000117"];
  steps.forEach((price, index) => {
    saveCollection(db, catalogue(price), [destination], new Date(start + index * hour).toISOString());
    prepareDeliveries(db, start + index * hour + hour / 2);
  });
  // The hour that holds the last step only comes round on its own schedule.
  prepareDeliveries(db, start + 3 * hour);

  const recorded = suppressions(db);
  expect(recorded).toHaveLength(1);
  expect(recorded[0]?.reason).toBe("waiting_for_the_move_to_settle");
  expect(recorded[0]?.detail).toContain("six hours ago");
  db.close();
});
