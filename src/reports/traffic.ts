import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config.js";
import { round } from "../numbers.js";
import { sourceJobs } from "../sources/registry.js";
import { collectionWindowFrom, dayFrom } from "../storage/collectionDays.js";

type TrafficSource = {
  id: string;
  label: string;
  measuredSince: string;
  attempts: number;
  requests: number;
  requestsPerDay: number | null;
  bodyReads: number;
  bytesDecoded: number;
  bytesPerDay: number | null;
  /** Declared body lengths; null when any read body lacks Content-Length. */
  bytesWire: number | null;
  cacheHits: number;
  averageBodyBytes: number | null;
  notModifiedShare: number | null;
  events: number;
  bytesPerEvent: number | null;
  bytesPerRecord: number | null;
};

export type TrafficReport = {
  since: string;
  measuredSince: string | null;
  days: number;
  reading: string;
  totals: { requests: number; bytesDecoded: number; bytesPerDay: number | null; events: number };
  sources: TrafficSource[];
  unmeasured: string[];
};

type Row = {
  source: string;
  attempts: number;
  requests: number;
  body_reads: number;
  bytes_decoded: number;
  bytes_wire: number | null;
  not_modified: number;
  cache_hits: number;
  events_created: number;
  records_processed: number;
  first_at: string;
};

const ratio = (top: number, bottom: number): number | null => (bottom > 0 ? round(top / bottom, 1) : null);
const perDay = (count: number, since: string | null, now: number): number | null =>
  since ? ratio(count * 86_400_000, now - Date.parse(since)) : null;

function trafficSource(row: Row, label: string, now: number): TrafficSource {
  return {
    id: row.source,
    label,
    measuredSince: row.first_at,
    attempts: row.attempts,
    requests: row.requests,
    requestsPerDay: perDay(row.requests, row.first_at, now),
    bodyReads: row.body_reads,
    bytesDecoded: row.bytes_decoded,
    bytesPerDay: perDay(row.bytes_decoded, row.first_at, now),
    bytesWire: row.bytes_wire,
    cacheHits: row.cache_hits,
    averageBodyBytes: row.body_reads > 0 ? Math.round(row.bytes_decoded / row.body_reads) : null,
    notModifiedShare: row.requests > 0 ? round(row.not_modified / row.requests, 3) : null,
    events: row.events_created,
    bytesPerEvent: ratio(row.bytes_decoded, row.events_created),
    bytesPerRecord: ratio(row.bytes_decoded, row.records_processed),
  };
}

/** Bytes and output share the same measured attempts, including failed reads and unchanged watches. */
export function traffic(db: Database, config: AppConfig, days: number, now = Date.now()): TrafficReport {
  const since = collectionWindowFrom(days, now);
  const rows = db
    .query<Row, [string]>(
      `SELECT source, SUM(attempts) AS attempts, SUM(requests) AS requests,
      SUM(body_reads) AS body_reads, SUM(bytes_decoded) AS bytes_decoded,
      CASE WHEN COUNT(bytes_wire)=COUNT(*) THEN SUM(bytes_wire) ELSE NULL END AS bytes_wire,
      SUM(not_modified) AS not_modified, SUM(cache_hits) AS cache_hits,
      SUM(events_created) AS events_created, SUM(records_processed) AS records_processed,
      MIN(first_at) AS first_at
    FROM source_traffic_days WHERE day >= ? GROUP BY source`,
    )
    .all(dayFrom(since));
  const live = new Map(sourceJobs(db, config).map((job) => [job.id, job.label]));
  const sources = rows.flatMap((row) => {
    const label = live.get(row.source);
    return label === undefined ? [] : [trafficSource(row, label, now)];
  });
  sources.sort((left, right) => {
    if (left.bytesPerEvent === null && right.bytesPerEvent === null) return left.id.localeCompare(right.id);
    if (left.bytesPerEvent === null) return 1;
    if (right.bytesPerEvent === null) return -1;
    return right.bytesPerEvent - left.bytesPerEvent || left.id.localeCompare(right.id);
  });
  const measured = new Set(sources.map((source) => source.id));
  const unmeasured = db
    .query<{ id: string }, [string]>("SELECT id FROM live_sources WHERE checked_at >= ?")
    .all(since)
    .map((row) => row.id)
    .filter((id) => live.has(id) && !measured.has(id))
    .sort();
  const measuredSince = sources.map((source) => source.measuredSince).sort()[0] ?? null;
  const sum = (read: (source: TrafficSource) => number) => sources.reduce((total, row) => total + read(row), 0);
  const bytesDecoded = sum((row) => row.bytesDecoded);
  return {
    since,
    measuredSince,
    days,
    reading:
      "Ranked by bytesPerEvent from the same measured attempts. Rates use elapsed time since " +
      "measuredSince, including a partial first day. Requests include retries and cheap watches; " +
      "notModifiedShare counts upstream 304s, while cacheHits made no request. Average bodies use " +
      "actual body reads. bytesWire sums declared lengths and is null if any body had no length; " +
      "it does not measure transfer framing or bytes consumed by cancelled responses.",
    totals: {
      requests: sum((row) => row.requests),
      bytesDecoded,
      bytesPerDay: perDay(bytesDecoded, measuredSince, now),
      events: sum((row) => row.events),
    },
    sources,
    unmeasured,
  };
}
