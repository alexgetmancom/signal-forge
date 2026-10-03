import type { Database } from "bun:sqlite";
import { storageFailure } from "../failure.js";
import { compressPayload } from "./payloadCodec.js";
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
