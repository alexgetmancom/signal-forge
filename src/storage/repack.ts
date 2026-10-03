import type { Database } from "bun:sqlite";
import { gatewayModels, openRouterSchema } from "../catalogPayloads.js";
import { storageFailure } from "../failure.js";
import { compressPayload, decompressPayload } from "./payloadCodec.js";
import { writeTransaction } from "./transaction.js";

export type RepackingResult = {
  snapshots: number;
  cacheEntries: number;
  beforeBytes: number;
  afterBytes: number;
  freedBytes: number;
  elapsedMs: number;
};

/**
 * Repack the gzip bodies left by the previous writer, without changing their evidence.
 *
 * Ten bodies per transaction bounds both memory and the write lock. A committed chunk no longer
 * matches the gzip header, so an interrupted run resumes and a second complete run writes nothing.
 * Bytes stay bytes: decoding as UTF-8 and encoding again would corrupt a non-UTF-8 payload.
 */
export function repackStoredPayloads(db: Database): RepackingResult {
  const started = performance.now();
  type Row = { key: number | string; body: Uint8Array };
  const targets = [
    {
      count: "snapshots" as const,
      select: db.query<Row, []>(
        "SELECT id AS key,body FROM snapshots WHERE substr(body,1,2)=X'1F8B' ORDER BY id LIMIT 10",
      ),
      update: db.query<never, [Uint8Array, number | string]>("UPDATE snapshots SET body=? WHERE id=?"),
    },
    {
      count: "cacheEntries" as const,
      select: db.query<Row, []>(
        "SELECT url AS key,body FROM http_cache WHERE substr(body,1,2)=X'1F8B' ORDER BY url LIMIT 10",
      ),
      update: db.query<never, [Uint8Array, number | string]>("UPDATE http_cache SET body=? WHERE url=?"),
    },
  ];
  const result: RepackingResult = {
    snapshots: 0,
    cacheEntries: 0,
    beforeBytes: 0,
    afterBytes: 0,
    freedBytes: 0,
    elapsedMs: 0,
  };
  for (const target of targets) {
    for (;;) {
      const chunk = writeTransaction(db, () => {
        const rows = target.select.all();
        let before = 0;
        let after = 0;
        for (const row of rows) {
          const packed = repackGzip(row.body);
          if (target.update.run(packed, row.key).changes !== 1) throw storageFailure("a repacked payload");
          before += row.body.byteLength;
          after += packed.byteLength;
        }
        return { rows: rows.length, before, after };
      });
      result[target.count] += chunk.rows;
      result.beforeBytes += chunk.before;
      result.afterBytes += chunk.after;
      if (chunk.rows < 10) break;
    }
  }
  result.freedBytes = result.beforeBytes - result.afterBytes;
  result.elapsedMs = Math.round(performance.now() - started);
  return result;
}

/** Refuse a corrupt body or a changed round trip before the transaction writes it. */
function repackGzip(body: Uint8Array): Uint8Array {
  try {
    const raw = Bun.gunzipSync(new Uint8Array(body));
    const packed = compressPayload(raw);
    if (!Buffer.from(Bun.zstdDecompressSync(packed)).equals(Buffer.from(raw)))
      throw storageFailure("a repacked payload round trip");
    return packed;
  } catch {
    throw storageFailure("a gzip payload could not be repacked without changing its bytes");
  }
}

export type CatalogTrimmingResult = {
  snapshots: number;
  beforeBytes: number;
  afterBytes: number;
  freedBytes: number;
};

/**
 * Remove unconsumed OpenRouter and Gateway fields using the collectors' own schemas.
 *
 * IDs, collection times and event references stay put; hashes and byte counts describe the new
 * evidence. Ten bodies per transaction keeps a corrupt body local to its chunk, and already
 * projected bodies are left alone. The legacy Gateway body is a JSON-encoded JSON string.
 */
export function trimCatalogSnapshots(db: Database): CatalogTrimmingResult {
  const result: CatalogTrimmingResult = { snapshots: 0, beforeBytes: 0, afterBytes: 0, freedBytes: 0 };
  const select = db.query<{ id: number; body: Uint8Array }, [string, number]>(
    "SELECT id,body FROM snapshots WHERE source=? AND body IS NOT NULL AND id>? ORDER BY id LIMIT 10",
  );
  const update = db.query<never, [Uint8Array, string, number, number]>(
    "UPDATE snapshots SET body=?,hash=?,bytes=? WHERE id=?",
  );
  for (const [source, schema] of [
    ["openrouter", openRouterSchema],
    ["vercel-gateway", gatewayModels],
  ] as const) {
    let cursor = 0;
    for (;;) {
      const chunk = writeTransaction(db, () => {
        const rows = select.all(source, cursor);
        let changed = 0,
          before = 0,
          after = 0;
        for (const row of rows) {
          const original = decompressPayload(row.body);
          let payload: unknown;
          let raw: string;
          try {
            payload = JSON.parse(original);
            if (typeof payload === "string") payload = JSON.parse(payload);
            raw = JSON.stringify(schema.parse(payload));
          } catch {
            throw storageFailure("a catalogue snapshot could not be trimmed without its model fields");
          }
          if (raw === original) continue;
          const packed = compressPayload(raw);
          if (decompressPayload(packed) !== raw) throw storageFailure("a trimmed catalogue round trip");
          const hash = new Bun.CryptoHasher("sha256").update(raw).digest("hex");
          if (update.run(packed, hash, Buffer.byteLength(raw), row.id).changes !== 1)
            throw storageFailure("a trimmed catalogue snapshot");
          changed++;
          before += row.body.byteLength;
          after += packed.byteLength;
        }
        return { rows: rows.length, last: rows.at(-1)?.id ?? cursor, changed, before, after };
      });
      cursor = chunk.last;
      result.snapshots += chunk.changed;
      result.beforeBytes += chunk.before;
      result.afterBytes += chunk.after;
      if (chunk.rows < 10) break;
    }
  }
  result.freedBytes = result.beforeBytes - result.afterBytes;
  return result;
}
