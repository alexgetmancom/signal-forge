import { expect, test } from "bun:test";
import { openDatabase } from "../src/storage/database.js";
import { HttpCache } from "../src/storage/httpCache.js";
import { decompressPayload, payloadFormat } from "../src/storage/payloadCodec.js";
import { repackStoredPayloads } from "../src/storage/repack.js";
import { storeSnapshot } from "../src/storage/snapshots.js";

const instant = "2026-10-03T18:00:00.000Z";

test("repacking preserves receipts, Unicode bodies, cache validators and already packed blobs", () => {
  const db = openDatabase(":memory:");
  const text = JSON.stringify({ name: "\u65b0\u6a21\u578b \ud83e\udde0", description: "x".repeat(20_000) });
  const old = storeSnapshot(db, "old", instant, text);
  const fresh = storeSnapshot(db, "new", instant, text);
  db.query("UPDATE snapshots SET body=? WHERE id=?").run(Bun.gzipSync(Buffer.from(text)), old.id);
  const receipts = db.query("SELECT id,source,collected_at,hash,bytes,expired_at FROM snapshots ORDER BY id").all();
  const freshBody = db
    .query<{ body: Uint8Array }, [number]>("SELECT body FROM snapshots WHERE id=?")
    .get(fresh.id)?.body;
  const cache = new HttpCache(db);
  const entry = { body: text, etag: '"same"', lastModified: "Sat, 03 Oct 2026 18:00:00 GMT", freshUntil: 0 };
  cache.put("https://example.test/catalogue", entry);
  db.query("UPDATE http_cache SET body=?").run(Bun.gzipSync(Buffer.from(text)));
  const cacheReceipt = db.query("SELECT url,etag,last_modified,fresh_until_at,used_at FROM http_cache").all();

  const result = repackStoredPayloads(db);

  expect(result).toMatchObject({ snapshots: 1, cacheEntries: 1 });
  expect(result.freedBytes).toBe(result.beforeBytes - result.afterBytes);
  expect(db.query("SELECT id,source,collected_at,hash,bytes,expired_at FROM snapshots ORDER BY id").all()).toEqual(
    receipts,
  );
  expect(db.query("SELECT url,etag,last_modified,fresh_until_at,used_at FROM http_cache").all()).toEqual(cacheReceipt);
  expect(cache.get("https://example.test/catalogue")).toEqual(entry);
  const bodies = db.query<{ body: Uint8Array }, []>("SELECT body FROM snapshots ORDER BY id").all();
  expect(bodies.map((row) => payloadFormat(row.body))).toEqual(["zstd", "zstd"]);
  expect(bodies.map((row) => decompressPayload(row.body))).toEqual([text, text]);
  expect(bodies[1]?.body).toEqual(freshBody);
  expect(repackStoredPayloads(db)).toMatchObject({ snapshots: 0, cacheEntries: 0, beforeBytes: 0, afterBytes: 0 });
  db.close();
});

test("a byte payload is not silently round-tripped through a text decoder", () => {
  const db = openDatabase(":memory:");
  const snapshot = storeSnapshot(db, "bytes", instant, "receipt");
  const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x61]);
  db.query("UPDATE snapshots SET body=? WHERE id=?").run(Bun.gzipSync(bytes), snapshot.id);

  expect(repackStoredPayloads(db).snapshots).toBe(1);
  const stored = db
    .query<{ body: Uint8Array }, [number]>("SELECT body FROM snapshots WHERE id=?")
    .get(snapshot.id)?.body;
  expect(stored).toBeDefined();
  if (!stored) throw new Error("Snapshot body missing after repacking");
  expect([...Bun.zstdDecompressSync(new Uint8Array(stored))]).toEqual([...bytes]);
  db.close();
});

test("a damaged body rolls back its chunk, while completed chunks stay resumable", () => {
  const db = openDatabase(":memory:");
  const ids: number[] = [];
  for (let index = 0; index < 12; index++) {
    const text = JSON.stringify({ index });
    const row = storeSnapshot(db, "resume", instant, text);
    ids.push(row.id);
    db.query("UPDATE snapshots SET body=? WHERE id=?").run(Bun.gzipSync(Buffer.from(text)), row.id);
  }
  db.query("UPDATE snapshots SET body=? WHERE id=?").run(new Uint8Array([0x1f, 0x8b, 0, 0]), ids[11] as number);

  expect(() => repackStoredPayloads(db)).toThrow("could not be repacked");
  const remaining = db.query<{ body: Uint8Array }, []>("SELECT body FROM snapshots ORDER BY id").all();
  expect(remaining.slice(0, 10).every((row) => payloadFormat(row.body) === "zstd")).toBe(true);
  expect(remaining.slice(10).every((row) => payloadFormat(row.body) === "gzip")).toBe(true);
  db.query("UPDATE snapshots SET body=? WHERE id=?").run(Bun.gzipSync(Buffer.from('{"index":11}')), ids[11] as number);
  expect(repackStoredPayloads(db).snapshots).toBe(2);
  expect(repackStoredPayloads(db).snapshots).toBe(0);
  db.close();
});
