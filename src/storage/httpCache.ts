import type { Database } from "bun:sqlite";

/**
 * An HTTP cache, which is what this crawler was missing: every observation re-downloaded pages it
 * already had. Two savings, and they are different. A page with an ETag still costs a request, but
 * the answer is a 304 with no body. An asset declared `immutable` costs nothing at all — its URL
 * carries a content hash, so the same URL can never hold different bytes.
 */
export type CacheEntry = { etag: string | null; lastModified: string | null; freshUntil: number; body: string };

/** Bodies not read for this long are dropped; a rebuilt bundle renames every file it ships. */
const KEEP_MS = 14 * 24 * 3_600_000;

/**
 * What the cache may weigh. Two weeks of bundles from the sites being watched came to 335 MB —
 * more than every compressed evidence payload in the database put together, for rows that exist
 * only to save a download. Age alone does not bound that, because the volume depends on how much
 * those sites ship, so the cache is bounded by construction: past this, the least recently used
 * entries go until it fits. Nothing here is evidence; a dropped entry costs one more request.
 */
const BUDGET_BYTES = 150 * 1024 * 1024;

export class HttpCache {
  constructor(private readonly db: Database) {}

  get(url: string): CacheEntry | null {
    const row = this.db
      .query<{ etag: string | null; last_modified: string | null; fresh_until: number; body: string }, [string]>(
        "SELECT etag,last_modified,fresh_until,body FROM http_cache WHERE url=?",
      )
      .get(url);
    if (!row) return null;
    return { etag: row.etag, lastModified: row.last_modified, freshUntil: row.fresh_until, body: row.body };
  }

  put(url: string, entry: CacheEntry, now = Date.now()): void {
    this.db
      .query(
        `INSERT INTO http_cache(url,etag,last_modified,fresh_until,body,used_at) VALUES(?,?,?,?,?,?)
         ON CONFLICT(url) DO UPDATE SET etag=excluded.etag,last_modified=excluded.last_modified,
           fresh_until=excluded.fresh_until,body=excluded.body,used_at=excluded.used_at`,
      )
      .run(url, entry.etag, entry.lastModified, entry.freshUntil, entry.body, now);
  }

  touch(url: string, freshUntil: number, now = Date.now()): void {
    this.db.query("UPDATE http_cache SET fresh_until=?,used_at=? WHERE url=?").run(freshUntil, now, url);
  }

  prune(now = Date.now()): number {
    const expired = this.db.query("DELETE FROM http_cache WHERE used_at < ?").run(now - KEEP_MS).changes;
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
  if (!cacheControl || !/\bimmutable\b/.test(cacheControl)) return 0;
  const maxAge = Number(cacheControl.match(/\bmax-age=(\d+)/)?.[1] ?? 0);
  return maxAge > 0 ? now + Math.min(maxAge, 30 * 24 * 3600) * 1000 : 0;
}
