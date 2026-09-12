import type { Database } from "bun:sqlite";

/**
 * A collected payload, kept compressed.
 *
 * The bytes are the deepest evidence a card can be traced to, so they are stored exactly as they
 * arrived — gzipped, which is about five times smaller on the JSON and HTML these sources serve,
 * and nothing else changed about them. The hash identifies a payload without reading it back:
 * recognising an unchanged poll used to mean pulling a 21 MB page out of the database every time.
 */
export type StoredSnapshot = { id: number; hash: string; bytes: number };

export function hashPayload(raw: string): string {
  return new Bun.CryptoHasher("sha256").update(raw).digest("hex");
}

/** Stores one payload, reusing the row when the source has just served the same bytes. */
export function storeSnapshot(db: Database, source: string, collectedAt: string, raw: string): StoredSnapshot {
  const hash = hashPayload(raw);
  const latest = db
    .query<{ id: number; hash: string; bytes: number }, [string]>(
      "SELECT id,hash,bytes FROM snapshots WHERE source=? ORDER BY id DESC LIMIT 1",
    )
    .get(source);
  if (latest && latest.hash === hash) return latest;
  const bytes = Buffer.byteLength(raw);
  const stored = db
    .query<{ id: number }, [string, string, Uint8Array, string, number]>(
      "INSERT INTO snapshots(source,collected_at,raw_json,body,hash,bytes) VALUES(?,?,'',?,?,?) RETURNING id",
    )
    .get(source, collectedAt, Bun.gzipSync(Buffer.from(raw)), hash, bytes);
  if (!stored) throw new Error("Snapshot insert failed");
  return { id: stored.id, hash, bytes };
}

/**
 * The payload back as it arrived, or null when its body has been released after its retention
 * window. A caller that needs the bytes must handle their absence rather than assume an empty
 * document: an expired payload is not an empty one.
 */
export function readSnapshot(db: Database, id: number): string | null {
  const row = db.query<{ body: Uint8Array | null }, [number]>("SELECT body FROM snapshots WHERE id=?").get(id);
  if (!row?.body) return null;
  return Buffer.from(Bun.gunzipSync(new Uint8Array(row.body))).toString("utf8");
}

/** The newest payload a source produced, for reading state that is not worth an event. */
export function readLatestSnapshot(db: Database, source: string): string | null {
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM snapshots WHERE source=? ORDER BY id DESC LIMIT 1")
    .get(source);
  return row ? readSnapshot(db, row.id) : null;
}
