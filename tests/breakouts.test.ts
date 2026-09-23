import { expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import { breakoutLine, breakoutOf, detectBreakouts, isLearnedMaker } from "../src/events/breakouts.js";
import { signalClass } from "../src/events/signals.js";
import type { Event } from "../src/events/types.js";
import { openDatabase } from "../src/storage/database.js";

const scouts = { id: "scouts", type: "discord", signals: ["codename"] } as unknown as Destination;
const now = Date.parse("2026-09-17T20:00:00.000Z");

function setup() {
  const db = openDatabase(":memory:");
  db.exec("INSERT INTO snapshots(id,source,collected_at) VALUES(1,'x','2026-09-01T00:00:00.000Z')");
  const add = (source: string, stream: string, entity: string, record: object, at: string) =>
    db
      .query<{ id: number }, [string, string, string, string, string]>(
        "INSERT INTO events(source,stream,entity_id,kind,after_json,detected_at,snapshot_id) VALUES(?,?,?,'new',?,?,1) RETURNING id",
      )
      .get(source, stream, entity, JSON.stringify(record), at)?.id ?? 0;
  const arrival = add(
    "vercel",
    "api-models",
    "acme-labs/zorblax-1",
    { id: "acme-labs/zorblax-1", name: "Zorblax 1" },
    "2026-09-16T23:50:00.000Z",
  );
  return { db, add, arrival };
}

test("a small company's model at a reseller is a recap line until nothing happens", () => {
  const { db, arrival } = setup();
  const event = db.query<Event, [number]>("SELECT * FROM events WHERE id=?").get(arrival) as Event;
  expect(signalClass(event)).toBe("evidence");
  expect(detectBreakouts(db, [scouts], now)).toEqual([]);
});

test("a second catalogue makes it a card and follows its maker", () => {
  const { db, add, arrival } = setup();
  add(
    "openrouter",
    "openrouter",
    "~acme/zorblax-1",
    { id: "~acme/zorblax-1", name: "Acme: Zorblax 1" },
    "2026-09-17T18:59:00.000Z",
  );
  expect(detectBreakouts(db, [scouts], now)).toEqual([arrival]);
  expect(isLearnedMaker(db, "~acme")).toBe(true);
  expect(db.query("SELECT signal FROM batch_events WHERE event_id=?").get(arrival)).toEqual({ signal: "codename" });
  const event = db.query<Event, [number]>("SELECT * FROM events WHERE id=?").get(arrival) as Event;
  const breakout = breakoutOf(db, arrival);
  if (!breakout) throw new Error("no breakout stored");
  expect(breakoutLine(event, breakout)).toBe("🔥 Acme Zorblax 1 is taking off: listed by 2 catalogues");
  expect(detectBreakouts(db, [scouts], now)).toEqual([]);
});

test("three new repositories count, unless the name was already in use", () => {
  const { db, add, arrival } = setup();
  for (const name of ["a", "b", "c"])
    add("discovery:github", "repos", `${name}/zorblax-agent`, {}, "2026-09-17T10:00:00.000Z");
  expect(detectBreakouts(db, [scouts], now)).toEqual([arrival]);

  const old = setup();
  old.add("discovery:github", "repos", "old/zorblax", {}, "2026-09-01T10:00:00.000Z");
  for (const name of ["a", "b", "c"])
    old.add("discovery:github", "repos", `${name}/zorblax-agent`, {}, "2026-09-17T10:00:00.000Z");
  expect(detectBreakouts(old.db, [scouts], now)).toEqual([]);
});

test("a mirror catalogue does not count, and a model already carded is not carded again", () => {
  const { db, add } = setup();
  add(
    "models-dev",
    "api-models",
    "acme-labs/zorblax-1",
    { id: "acme-labs/zorblax-1", name: "Zorblax 1" },
    "2026-09-17T10:00:00.000Z",
  );
  expect(detectBreakouts(db, [scouts], now)).toEqual([]);
});

test("a Hacker News story counts", () => {
  const { db, add, arrival } = setup();
  add("hackernews", "stories", "hn-1", { name: "Zorblax 1 beats everything" }, "2026-09-17T12:00:00.000Z");
  expect(detectBreakouts(db, [scouts], now)).toEqual([arrival]);
});

test("a model that was already out is not taking off when one more catalogue imports it", () => {
  const { db, add, arrival } = setup();
  // Another catalogue has held the model since August and its record says so; Azure's row, which
  // names no maker and carries no date, is an import.
  db.query("INSERT INTO records(source,id,body,stream) VALUES(?,?,?,?)").run(
    "huggingface-router",
    "acme-labs/zorblax-1",
    JSON.stringify({ id: "acme-labs/zorblax-1", created: "2026-08-01T00:00:00.000Z" }),
    "weights",
  );
  add("hackernews", "news", "story-1", { name: "Zorblax 1 is remarkably good" }, "2026-09-17T19:00:00.000Z");
  expect(detectBreakouts(db, [scouts], now)).toEqual([]);
  expect(breakoutOf(db, arrival)).toBeNull();
});
