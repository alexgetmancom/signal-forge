import { expect, test } from "bun:test";
import { openDatabase } from "../src/storage/database.js";
import { HttpCache } from "../src/storage/httpCache.js";
import { expireSnapshotBodies, pruneShadowCandidates, pruneSnapshots } from "../src/storage/retention.js";
import { readSnapshot, storeSnapshot } from "../src/storage/snapshots.js";

const now = Date.parse("2026-09-12T00:00:00.000Z");

function snapshot(db: ReturnType<typeof openDatabase>, source: string, hoursAgo: number): void {
  // Each reading differs, as real payloads do; identical bytes would be stored once.
  storeSnapshot(db, source, new Date(now - hoursAgo * 3_600_000).toISOString(), `{"payload":"${hoursAgo}"}`);
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

test("a payload is stored compressed and comes back exactly as it arrived", () => {
  const db = openDatabase(":memory:");
  const payload = JSON.stringify({ models: Array.from({ length: 500 }, (_, index) => ({ id: `model-${index}` })) });
  const stored = storeSnapshot(db, "openrouter", new Date(now).toISOString(), payload);

  expect(readSnapshot(db, stored.id)).toBe(payload);
  const row = db
    .query<{ size: number; hash: string; bytes: number }, [number]>(
      "SELECT LENGTH(body) AS size,hash,bytes FROM snapshots WHERE id=?",
    )
    .get(stored.id);
  expect(row?.bytes).toBe(Buffer.byteLength(payload));
  expect(row?.size).toBeLessThan(Buffer.byteLength(payload) / 2);
  expect(row?.hash).toHaveLength(64);
  db.close();
});

test("the same bytes twice in a row are stored once", () => {
  const db = openDatabase(":memory:");
  const payload = '{"a":1}';
  const first = storeSnapshot(db, "arena", new Date(now).toISOString(), payload);
  const second = storeSnapshot(db, "arena", new Date(now + 1000).toISOString(), payload);
  expect(second.id).toBe(first.id);
  expect(storeSnapshot(db, "arena", new Date(now + 2000).toISOString(), '{"a":2}').id).not.toBe(first.id);
  db.close();
});

test("a payload past its lifetime leaves a receipt, not a hole", () => {
  const db = openDatabase(":memory:");
  const old = storeSnapshot(db, "claude-web", new Date(now - 100 * 24 * 3_600_000).toISOString(), '{"page":"old"}');
  const recent = storeSnapshot(db, "claude-web", new Date(now - 24 * 3_600_000).toISOString(), '{"page":"new"}');
  expect(expireSnapshotBodies(db, now)).toBe(1);

  expect(readSnapshot(db, old.id)).toBeNull();
  expect(readSnapshot(db, recent.id)).toBe('{"page":"new"}');
  const receipt = db
    .query<{ source: string; hash: string; bytes: number; expired_at: string | null }, [number]>(
      "SELECT source,hash,bytes,expired_at FROM snapshots WHERE id=?",
    )
    .get(old.id);
  // What the bytes were and that they existed survives; only the bytes are released.
  expect(receipt).toMatchObject({ source: "claude-web", bytes: 14 });
  expect(receipt?.hash).toHaveLength(64);
  expect(receipt?.expired_at).toBe(new Date(now).toISOString());
  db.close();
});

test("shadow candidates nobody ever used are dropped, delivered evidence is not", () => {
  const db = openDatabase(":memory:");
  const snapshot = storeSnapshot(db, "discovery:huggingface-recent", new Date(now).toISOString(), "{}");
  const event = (source: string, daysAgo: number) =>
    db
      .query<{ id: number }, [string, string, number]>(
        `INSERT INTO events(source,stream,entity_id,kind,after_json,detected_at,snapshot_id)
         VALUES(?,'weights','model','new','{}',?,?) RETURNING id`,
      )
      .get(source, new Date(now - daysAgo * 24 * 3_600_000).toISOString(), snapshot.id);

  const old = event("discovery:huggingface-recent", 40);
  const recent = event("discovery:huggingface-recent", 5);
  const delivered = event("discovery:huggingface-recent", 40);
  db.query("INSERT INTO batches(id,source,ready_at,sealed) VALUES(1,'test',0,1)").run();
  db.query("INSERT INTO batch_events(batch_id,event_id,url) VALUES(1,?,'')").run(delivered?.id ?? 0);

  expect(pruneShadowCandidates(db, ["discovery:huggingface-recent"], now)).toBe(1);
  const left = db
    .query<{ id: number }, []>("SELECT id FROM events ORDER BY id")
    .all()
    .map((row) => row.id);
  expect(left).not.toContain(old?.id ?? -1);
  expect(left).toContain(recent?.id ?? -1);
  // An event that reached a batch is evidence somebody was told about, whatever its age.
  expect(left).toContain(delivered?.id ?? -1);
  db.close();
});

test("an active source keeps its old events", () => {
  const db = openDatabase(":memory:");
  const snapshot = storeSnapshot(db, "openrouter", new Date(now).toISOString(), "{}");
  db.query(
    `INSERT INTO events(source,stream,entity_id,kind,after_json,detected_at,snapshot_id)
     VALUES('openrouter','openrouter','gpt-5','new','{}',?,?)`,
  ).run(new Date(now - 400 * 24 * 3_600_000).toISOString(), snapshot.id);

  expect(pruneShadowCandidates(db, ["discovery:huggingface-recent"], now)).toBe(0);
  expect(db.query<{ c: number }, []>("SELECT COUNT(*) c FROM events").get()?.c).toBe(1);
  db.close();
});

test("the response cache is bounded by size, not only by age", () => {
  const db = openDatabase(":memory:");
  const cache = new HttpCache(db);
  const body = "x".repeat(2 * 1024 * 1024);
  // Ninety bundles of two megabytes: two weeks old or not, this cannot be allowed to stay.
  for (let index = 0; index < 90; index++)
    cache.put(
      `https://example.test/bundle-${index}.js`,
      { etag: null, lastModified: null, freshUntil: 0, body },
      now - index * 60_000,
    );

  expect(cache.prune(now)).toBeGreaterThan(0);
  const bytes =
    db.query<{ bytes: number | null }, []>("SELECT SUM(LENGTH(body)) AS bytes FROM http_cache").get()?.bytes ?? 0;
  expect(bytes).toBeLessThanOrEqual(150 * 1024 * 1024);
  // What survives is what was used most recently.
  expect(cache.get("https://example.test/bundle-0.js")).not.toBeNull();
  expect(cache.get("https://example.test/bundle-89.js")).toBeNull();
  db.close();
});
