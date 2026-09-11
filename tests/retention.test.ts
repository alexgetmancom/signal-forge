import { expect, test } from "bun:test";
import { openDatabase } from "../src/storage/database.js";
import { pruneSnapshots } from "../src/storage/retention.js";

const now = Date.parse("2026-09-12T00:00:00.000Z");

function snapshot(db: ReturnType<typeof openDatabase>, source: string, hoursAgo: number): void {
  db.query("INSERT INTO snapshots(source,collected_at,raw_json) VALUES(?,?,?)").run(
    source,
    new Date(now - hoursAgo * 3_600_000).toISOString(),
    '{"payload":"x"}',
  );
}

test("old raw payloads are dropped, the newest ones are kept whatever their age", () => {
  const db = openDatabase(":memory:");
  // A 21 MB page collected every twelve hours for five days.
  for (let hours = 120; hours >= 12; hours -= 12) snapshot(db, "claude-web", hours);
  expect(pruneSnapshots(db, now)).toBeGreaterThan(0);

  const kept = db.query<{ collected_at: string }, []>("SELECT collected_at FROM snapshots ORDER BY id").all();
  expect(kept).toHaveLength(3);
  // What stayed is the most recent evidence, which is what anybody checking a card would open.
  expect(kept.at(-1)?.collected_at).toBe(new Date(now - 12 * 3_600_000).toISOString());
  db.close();
});

test("a burst still being looked at is kept even beyond the count", () => {
  const db = openDatabase(":memory:");
  for (let hours = 5; hours >= 0; hours--) snapshot(db, "openrouter", hours);
  expect(pruneSnapshots(db, now)).toBe(0);
  db.close();
});

test("a source polled rarely keeps its evidence", () => {
  const db = openDatabase(":memory:");
  snapshot(db, "anthropic-news", 500);
  snapshot(db, "openai-news", 500);
  expect(pruneSnapshots(db, now)).toBe(0);
  expect(db.query<{ c: number }, []>("SELECT COUNT(*) c FROM snapshots").get()?.c).toBe(2);
  db.close();
});

test("each source is pruned on its own, not against the busiest one", () => {
  const db = openDatabase(":memory:");
  for (let hours = 120; hours >= 12; hours -= 6) snapshot(db, "openrouter", hours);
  snapshot(db, "arena", 96);
  pruneSnapshots(db, now);

  expect(db.query<{ c: number }, [string]>("SELECT COUNT(*) c FROM snapshots WHERE source=?").get("arena")?.c).toBe(1);
  expect(
    db.query<{ c: number }, [string]>("SELECT COUNT(*) c FROM snapshots WHERE source=?").get("openrouter")?.c,
  ).toBe(3);
  db.close();
});

test("a payload an event was derived from is never deleted", () => {
  const db = openDatabase(":memory:");
  for (let hours = 120; hours >= 12; hours -= 12) snapshot(db, "openrouter", hours);
  // The oldest reading is the one an event points back to.
  const oldest = db.query<{ id: number }, []>("SELECT id FROM snapshots ORDER BY id LIMIT 1").get();
  db.query(
    "INSERT INTO events(source,stream,entity_id,kind,after_json,detected_at,snapshot_id) VALUES('openrouter','openrouter','gpt-5','new','{}',?,?)",
  ).run(new Date(now - 120 * 3_600_000).toISOString(), oldest?.id ?? 0);

  pruneSnapshots(db, now);

  expect(db.query<{ c: number }, [number]>("SELECT COUNT(*) c FROM snapshots WHERE id=?").get(oldest?.id ?? 0)?.c).toBe(
    1,
  );
  // Its evidence survives; the readings nothing points at do not.
  expect(db.query<{ c: number }, []>("SELECT COUNT(*) c FROM snapshots").get()?.c).toBe(4);
  db.close();
});
