import { expect, test } from "bun:test";
import { openDatabase } from "../src/storage/database.js";
import { compressPayload, decompressPayload, payloadFormat } from "../src/storage/payloadCodec.js";
import { readSnapshot, storeSnapshot } from "../src/storage/snapshots.js";

const payload = JSON.stringify({
  models: Array.from({ length: 400 }, (_, index) => ({ id: `m${index}`, price: 1.5 })),
});

test("a payload written now is zstd, and comes back as itself", () => {
  const stored = compressPayload(payload);
  expect(payloadFormat(stored)).toBe("zstd");
  expect(stored.byteLength).toBeLessThan(Buffer.byteLength(payload));
  expect(decompressPayload(stored)).toBe(payload);
});

test("a payload written before this change is still read back", () => {
  // A restored backup or an interrupted compaction may still hold gzip bodies.
  const gzipped = Bun.gzipSync(Buffer.from(payload));
  expect(payloadFormat(gzipped)).toBe("gzip");
  expect(decompressPayload(gzipped)).toBe(payload);
});

test("a blob that is neither is refused rather than answered with", () => {
  const nonsense = new Uint8Array([1, 2, 3, 4, 5]);
  expect(payloadFormat(nonsense)).toBeNull();
  // An empty string here would be a card drawn from evidence that is not there.
  expect(() => decompressPayload(nonsense)).toThrow(/neither gzip nor zstd/);
});

test("a stored snapshot reads back whichever compressor wrote it", () => {
  const db = openDatabase(":memory:");
  const now = "2026-10-03T12:00:00.000Z";
  const fresh = storeSnapshot(db, "models-dev", now, payload);
  expect(readSnapshot(db, fresh.id)).toBe(payload);
  // The receipt is about the payload, not about how it was packed.
  expect(fresh.bytes).toBe(Buffer.byteLength(payload));

  // A row as the previous version of this code would have written it.
  const old = db
    .query<{ id: number }, [Uint8Array]>(
      "INSERT INTO snapshots(source,collected_at,body,hash,bytes) VALUES('arena','2026-10-01T00:00:00.000Z',?,'h',10) RETURNING id",
    )
    .get(Bun.gzipSync(Buffer.from(payload)));
  expect(readSnapshot(db, old?.id as number)).toBe(payload);
  db.close();
});
