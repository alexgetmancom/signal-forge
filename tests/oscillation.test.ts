import { expect, test } from "bun:test";
import { isOscillating, isScheduledPricingRotation } from "../src/events/oscillation.js";
import type { Event } from "../src/events/types.js";
import { type Collection, saveCollection } from "../src/events.js";
import { openDatabase } from "../src/storage/database.js";

const tiers = [
  { prompt: "0.00000015", completion: "0.0000006", utc_days: ["saturday", "sunday"] },
  { prompt: "0.0000003", completion: "0.0000012", utc_start: 100, utc_end: 400, utc_days: ["monday"] },
];
const cheap = { prompt: "0.00000015", completion: "0.0000006", overrides: tiers };
const dear = { prompt: "0.0000003", completion: "0.0000012", overrides: tiers };

const event = (before: unknown, after: unknown): Event => ({
  id: 7,
  source: "openrouter",
  stream: "openrouter",
  entity_id: "deepseek/deepseek-v4.1-flash",
  kind: "changed",
  before_json: JSON.stringify({ name: "DeepSeek V4.1 Flash", pricing: before }),
  after_json: JSON.stringify({ name: "DeepSeek V4.1 Flash", pricing: after }),
  detected_at: "2026-09-11T02:00:00.000Z",
});

test("a base price that lands on the record's own published tier is the schedule, not a reprice", () => {
  expect(isScheduledPricingRotation(event(cheap, dear))).toBe(true);
  expect(isScheduledPricingRotation(event(dear, cheap))).toBe(true);
});

test("a reprice away from every published tier is still news", () => {
  const repriced = { prompt: "0.0000009", completion: "0.0000036", overrides: tiers };
  expect(isScheduledPricingRotation(event(cheap, repriced))).toBe(false);
});

test("a catalogue without published tiers is never treated as scheduled", () => {
  expect(isScheduledPricingRotation(event({ prompt: "0.0000001" }, { prompt: "0.0000002" }))).toBe(false);
});

test("a new listing is never a rotation", () => {
  expect(isScheduledPricingRotation({ ...event(cheap, dear), kind: "new", before_json: null })).toBe(false);
});

const leaderboard = (rank: number): Collection => ({
  source: "designarena:website",
  stream: "leaderboards",
  url: "https://www.designarena.ai/leaderboard/website",
  raw: [],
  records: [{ id: "website:1", name: "claude-fable-5-1", category: "designarena/website", rank }],
});

function lastEvent(db: ReturnType<typeof openDatabase>): Event {
  const row = db.query<Event, []>("SELECT * FROM events ORDER BY id DESC LIMIT 1").get();
  if (!row) throw new Error("no event was recorded");
  return row;
}

test("a rank that keeps returning to a place it already held is dithering, not movement", () => {
  const db = openDatabase(":memory:");
  const now = Date.parse("2026-09-11T06:00:00.000Z");
  const ranks = [5, 6, 5, 6];
  for (const [index, rank] of ranks.entries())
    saveCollection(db, leaderboard(rank), [], new Date(now + index * 3_600_000).toISOString());
  expect(isOscillating(db, lastEvent(db), now + ranks.length * 3_600_000)).toBe(true);
  db.close();
});

test("a first reversal is not yet dithering", () => {
  const db = openDatabase(":memory:");
  const now = Date.parse("2026-09-11T06:00:00.000Z");
  for (const [index, rank] of [5, 6, 5].entries())
    saveCollection(db, leaderboard(rank), [], new Date(now + index * 3_600_000).toISOString());
  expect(isOscillating(db, lastEvent(db), now + 3 * 3_600_000)).toBe(false);
  db.close();
});

test("a rank that keeps climbing stays worth a message", () => {
  const db = openDatabase(":memory:");
  const now = Date.parse("2026-09-11T06:00:00.000Z");
  for (const [index, rank] of [9, 7, 5, 3].entries())
    saveCollection(db, leaderboard(rank), [], new Date(now + index * 3_600_000).toISOString());
  expect(isOscillating(db, lastEvent(db), now + 4 * 3_600_000)).toBe(false);
  db.close();
});

test("dithering older than the window no longer silences a change", () => {
  const db = openDatabase(":memory:");
  const start = Date.parse("2026-09-01T06:00:00.000Z");
  for (const [index, rank] of [5, 6, 5].entries())
    saveCollection(db, leaderboard(rank), [], new Date(start + index * 3_600_000).toISOString());
  const late = Date.parse("2026-09-11T06:00:00.000Z");
  saveCollection(db, leaderboard(6), [], new Date(late).toISOString());
  expect(isOscillating(db, lastEvent(db), late)).toBe(false);
  db.close();
});
