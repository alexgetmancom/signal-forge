import type { Database } from "bun:sqlite";
import { compressPayload, decompressPayload } from "./payloadCodec.js";

/**
 * An HTTP cache, which is what this crawler was missing: every observation re-downloaded pages it
 * already had. Two savings, and they are different. A page with an ETag still costs a request, but
 * the answer is a 304 with no body. An asset declared `immutable` costs nothing at all — its URL
 * carries a content hash, so the same URL can never hold different bytes.
 */
export type CacheEntry = { etag: string | null; lastModified: string | null; freshUntil: number; body: string };

/**
 * Freshness is arithmetic - a deadline in milliseconds from now - but what gets stored is an
 * instant like every other instant in this database, so the two representations meet here and
 * nowhere else.
 */
const instant = (epochMs: number): string => new Date(epochMs).toISOString();

/** Bodies not read for this long are dropped; a rebuilt bundle renames every file it ships. */
const KEEP_MS = 14 * 24 * 3_600_000;

/**
 * The compressed bytes the cache may hold. Production's 67 MB of text compressed to 9.3 MB on
 * 2026-10-03, in 313 ms for all 209 entries. Age alone does not bound the volume sites ship, so
 * least recently used entries go until it fits. A dropped entry costs one more request.
 *
 * Sixteen megabytes, not the sixty-four this was while the same number counted characters. Against
 * that compression the old figure allowed some 450 MB of text, so the budget would have risen
 * sevenfold at the moment it was meant to shrink the file, and the 58 MB the compression gave back
 * would have been lent rather than kept. This leaves production's cache at well under half its
 * ceiling, so the saving holds until the watched sites ship several times what they ship today.
 */
const BUDGET_BYTES = 16 * 1024 * 1024;

export class HttpCache {
  constructor(private readonly db: Database) {}

  get(url: string): CacheEntry | null {
    const row = this.db
      .query<{ etag: string | null; last_modified: string | null; fresh_until_at: string; body: Uint8Array }, [string]>(
        "SELECT etag,last_modified,fresh_until_at,body FROM http_cache WHERE url=?",
      )
      .get(url);
    if (!row) return null;
    return {
      etag: row.etag,
      lastModified: row.last_modified,
      freshUntil: Date.parse(row.fresh_until_at),
      body: decompressPayload(row.body),
    };
  }

  put(url: string, entry: CacheEntry, now = Date.now()): void {
    this.db
      .query(
        `INSERT INTO http_cache(url,etag,last_modified,fresh_until_at,body,used_at) VALUES(?,?,?,?,?,?)
         ON CONFLICT(url) DO UPDATE SET etag=excluded.etag,last_modified=excluded.last_modified,
           fresh_until_at=excluded.fresh_until_at,body=excluded.body,used_at=excluded.used_at`,
      )
      .run(url, entry.etag, entry.lastModified, instant(entry.freshUntil), compressPayload(entry.body), instant(now));
  }

  touch(url: string, freshUntil: number, now = Date.now()): void {
    this.db
      .query("UPDATE http_cache SET fresh_until_at=?,used_at=? WHERE url=?")
      .run(instant(freshUntil), instant(now), url);
  }

  prune(now = Date.now()): number {
    const expired = this.db.query("DELETE FROM http_cache WHERE used_at < ?").run(instant(now - KEEP_MS)).changes;
    return expired + this.evictToBudget();
  }

  /** Drops least recently used entries until the cache fits its budget. */
  private evictToBudget(): number {
    const total =
      this.db.query<{ bytes: number | null }, []>("SELECT SUM(LENGTH(body)) AS bytes FROM http_cache").get()?.bytes ??
      0;
    if (total <= BUDGET_BYTES) return 0;
    let dropped = 0;
    let remaining = total;
    // Oldest use first, in batches, so one eviction pass never holds the whole cache in memory.
    while (remaining > BUDGET_BYTES) {
      const victims = this.db
        .query<{ url: string; size: number }, []>(
          "SELECT url, LENGTH(body) AS size FROM http_cache ORDER BY used_at LIMIT 50",
        )
        .all();
      if (!victims.length) return dropped;
      for (const victim of victims) {
        this.db.query("DELETE FROM http_cache WHERE url=?").run(victim.url);
        remaining -= victim.size;
        dropped++;
        if (remaining <= BUDGET_BYTES) break;
      }
    }
    return dropped;
  }
}

/**
 * How long a response may be reused without asking again. Only `immutable` is trusted for a long
 * reuse: a plain `max-age` on a page we are watching for changes would make us miss the change we
 * exist to report, so anything else revalidates on the next observation.
 */
export function freshUntil(cacheControl: string | null, now = Date.now()): number {
  if (!cacheControl || !/\bimmutable\b/i.test(cacheControl)) return 0;
  const maxAge = Number(cacheControl.match(/\bmax-age=(\d+)/i)?.[1] ?? 0);
  return maxAge > 0 ? now + Math.min(maxAge, 30 * 24 * 3600) * 1000 : 0;
}

/**
 * URLs that more than one source reads, and how long one body may stand in for the next ask.
 *
 * `anthropic.com/news` is the whole list. `anthropic-news` reads the posts out of it and
 * `anthropic-routes` reads the route list out of the same 425 KB document -- one URL declared as two
 * sources, because the two answers go to different streams and different readers. The page sends no
 * ETag, no Last-Modified and `no-store`, so nothing above can save the second download: there is no
 * validator to ask with and no freshness to trust. What makes the reuse safe is not the server's
 * word but ours -- the two sources are asked on the same interval, and this window is shorter than
 * it, so exactly one of the pair fetches per round and neither is reading a body older than one of
 * their own cycles.
 *
 * Measured 2026-10-04: 288 fetches a day for routes and 96 for news, 425 KB each, 163 MB of the
 * same document. This leaves the 288.
 */
const SHARED_BODIES_MS: Record<string, number> = { "https://www.anthropic.com/news": 240_000 };

/**
 * How long this response may be reused: whichever is longer of what the server allows and what a
 * shared URL is deliberately given above.
 */
export function reusableUntil(url: string, cacheControl: string | null, now = Date.now()): number {
  const shared = SHARED_BODIES_MS[url];
  return Math.max(freshUntil(cacheControl, now), shared ? now + shared : 0);
}
