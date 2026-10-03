import type { Database } from "bun:sqlite";
import { storageFailure } from "../failure.js";
import { compressPayload, decompressPayload } from "./payloadCodec.js";

/**
 * A collected payload, kept compressed.
 *
 * These are the evidence bytes the collector returns, which can be a projection of its response.
 * Compression preserves them; `compact-storage` can trim old catalog evidence to the collector's
 * fields and updates its hash and size together. The hash identifies the stored payload without
 * reading it back: recognising an unchanged poll used to mean pulling a 21 MB page
 * out of the database every time.
 */
export type StoredSnapshot = { id: number; hash: string; bytes: number };

function hashPayload(raw: string): string {
  return new Bun.CryptoHasher("sha256").update(raw).digest("hex");
}

/** Stores one payload, reusing the row when the source has just served the same bytes. */
export function storeSnapshot(db: Database, source: string, collectedAt: string, raw: string): StoredSnapshot {
  const hash = hashPayload(raw);
  const latest = db
    .query<{ id: number; hash: string; bytes: number; kept: number }, [string]>(
      "SELECT id,hash,bytes,body IS NOT NULL AS kept FROM snapshots WHERE source=? ORDER BY id DESC LIMIT 1",
    )
    .get(source);
  // A row whose body retention released is a receipt, not a copy: reusing it would make the latest
  // payload unreadable for as long as the source keeps answering the same bytes.
  if (latest && latest.hash === hash && latest.kept) return { id: latest.id, hash: latest.hash, bytes: latest.bytes };
  const bytes = Buffer.byteLength(raw);
  const stored = db
    .query<{ id: number }, [string, string, Uint8Array, string, number]>(
      "INSERT INTO snapshots(source,collected_at,body,hash,bytes) VALUES(?,?,?,?,?) RETURNING id",
    )
    .get(source, collectedAt, compressPayload(raw), hash, bytes);
  if (!stored) throw storageFailure("a snapshot");
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
  return decompressPayload(row.body);
}

/** The newest payload a source produced, for reading state that is not worth an event. */
export function readLatestSnapshot(db: Database, source: string): string | null {
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM snapshots WHERE source=? ORDER BY id DESC LIMIT 1")
    .get(source);
  return row ? readSnapshot(db, row.id) : null;
}
