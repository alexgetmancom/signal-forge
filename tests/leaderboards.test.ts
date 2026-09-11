import { expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import { hasNotificationContent } from "../src/events/notification.js";
import type { Event } from "../src/events/types.js";
import { type Collection, prepareDeliveries, saveCollection } from "../src/events.js";
import { openDatabase } from "../src/storage/database.js";

const board = (records: Collection["records"]): Collection => ({
  source: "designarena:website",
  stream: "leaderboards",
  url: "https://www.designarena.ai/leaderboard/website",
  raw: records,
  trackChanges: true,
  records,
});

const entry = (id: string, rank: number) => ({ id, name: id, category: "designarena/website", rank });

const destination: Destination = { id: "codenames", platform: "discord", channelId: "1", signals: ["codename"] };

const rankMove = (from: number, to: number): Event =>
  ({
    id: 1,
    source: "designarena:website",
    stream: "leaderboards",
    entity_id: "gemini-3.7-flash",
    kind: "changed",
    detected_at: "2026-09-11T20:56:00.000Z",
    before_json: JSON.stringify({ id: "gemini-3.7-flash", name: "gemini-3.7-flash", rank: from }),
    after_json: JSON.stringify({ id: "gemini-3.7-flash", name: "gemini-3.7-flash", rank: to }),
  }) as Event;

test("a design board is read for who turns up, not for who is third today", () => {
  // Both a place near the bottom and a place at the very top: neither is news on this board.
  expect(hasNotificationContent(rankMove(10, 11))).toBe(false);
  expect(hasNotificationContent(rankMove(2, 1))).toBe(false);
});

test("an unannounced model arriving on a design board is news", () => {
  const db = openDatabase(":memory:");
  saveCollection(db, board([entry("claude-fable-5-1", 1)]), [destination], "2026-09-09T05:00:00.000Z");
  // gpt-6-astra reached first place on the board before it existed anywhere else.
  saveCollection(
    db,
    board([entry("gpt-6-astra", 1), entry("claude-fable-5-1", 2)]),
    [destination],
    "2026-09-09T06:18:00.000Z",
  );
  prepareDeliveries(db, Date.parse("2026-09-09T07:00:00.000Z"));

  const bodies = db
    .query<{ body: string }, []>("SELECT body FROM deliveries")
    .all()
    .map((row) => row.body)
    .join(" ");
  expect(bodies).toContain("gpt-6-astra");
  db.close();
});

test("a codename that keeps arriving and leaving is announced once", () => {
  const db = openDatabase(":memory:");
  const other = entry("claude-fable-5-1", 1);
  saveCollection(db, board([other]), [destination], "2026-09-09T01:00:00.000Z");
  // Arrives, leaves the next day, arrives again the day after, as muse-spark-1.3-max did.
  saveCollection(db, board([other, entry("muse-spark-1.3-max", 2)]), [destination], "2026-09-09T02:57:00.000Z");
  // A single absence is not a departure: the board has to omit it twice.
  saveCollection(db, board([other]), [destination], "2026-09-10T17:49:00.000Z");
  saveCollection(db, board([other]), [destination], "2026-09-10T18:49:00.000Z");
  saveCollection(db, board([other, entry("muse-spark-1.3-max", 2)]), [destination], "2026-09-11T07:53:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-11T09:00:00.000Z"));

  const arrivals = db
    .query<{ body: string }, []>("SELECT body FROM deliveries")
    .all()
    .filter((row) => row.body.includes("muse-spark-1.3-max"));
  expect(arrivals).toHaveLength(1);
  expect(
    db.query<{ reason: string }, []>("SELECT reason FROM suppressions WHERE reason='flapping_in_and_out'").all(),
  ).toHaveLength(1);
  db.close();
});
