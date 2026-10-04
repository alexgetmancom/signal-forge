import type { Database } from "bun:sqlite";
import { log } from "../logger.js";
import type { Traffic } from "../runtime/traffic.js";

/** One completed attempt, including failures and cheap watches, written directly into its day. */
export function recordTraffic(
  db: Database,
  source: string,
  at: string,
  traffic: Traffic,
  records = 0,
  events = 0,
): void {
  try {
    db.query(`INSERT INTO source_traffic_days(
      day, source, attempts, requests, body_reads, bytes_decoded, bytes_wire, not_modified,
      cache_hits, records_processed, events_created, first_at, last_at
    ) VALUES(substr(?1, 1, 10), ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?1, ?1)
    ON CONFLICT(day, source) DO UPDATE SET
      attempts = attempts + 1,
      requests = requests + excluded.requests,
      body_reads = body_reads + excluded.body_reads,
      bytes_decoded = bytes_decoded + excluded.bytes_decoded,
      bytes_wire = CASE WHEN bytes_wire IS NULL OR excluded.bytes_wire IS NULL THEN NULL
        ELSE bytes_wire + excluded.bytes_wire END,
      not_modified = not_modified + excluded.not_modified,
      cache_hits = cache_hits + excluded.cache_hits,
      records_processed = records_processed + excluded.records_processed,
      events_created = events_created + excluded.events_created,
      first_at = MIN(first_at, excluded.first_at), last_at = MAX(last_at, excluded.last_at)`).run(
      at,
      source,
      traffic.requests,
      traffic.bodyReads,
      traffic.bytesDecoded,
      traffic.bytesWire,
      traffic.notModified,
      traffic.cacheHits,
      records,
      events,
    );
  } catch (error) {
    log("warn", "Source traffic increment failed", {
      source,
      errorType: error instanceof Error ? error.name : "unknown",
    });
  }
}
