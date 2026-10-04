import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config.js";
import { round } from "../numbers.js";
import { sourceJobs } from "../sources/registry.js";
import { collectionWindowFrom, dayFrom } from "../storage/collectionDays.js";

/**
 * What each source asks of the network, and what it returns for it.
 *
 * The report exists to choose the next collector to narrow, so it is ranked by `bytesPerEvent`
 * rather than by bytes. Bytes alone name the biggest download, which is usually a catalogue doing
 * its job; bytes against what the collection produced name the download that is mostly thrown away,
 * which is the one a narrower request fixes. The two GitHub discovery reads that went from 474 KB
 * to 55 KB for the same 83 repositories would have sat mid-table by bytes and at the top here.
 *
 * It is a ranking, not a verdict. A source with no events in the window has no ratio and is listed
 * with a null rather than at the top: a catalogue that correctly reports nothing changed is not
 * wasteful, and sorting it above a real offender is how a list stops being read. What a high row
 * means is "open this collector and compare the fields it reads against the answer it asks for",
 * and that comparison is still a person with `bun run probe`.
 *
 * `bytesWire` against `bytesDecoded` is the second reading and a different repair. Far apart means
 * transport compression is already working and the cost is memory, so the fix is parsing or a
 * child; close together on a large body means nothing is compressed, and the fix may be as small as
 * an `accept-encoding` upstream honours.
 */
type TrafficSource = {
  id: string;
  label: string;
  /** Requests put on the wire in the window, retries excluded and cheap change-probes included. */
  requests: number;
  requestsPerDay: number;
  /** Bytes handed to the collector, after transport decompression: what it had to hold. */
  bytesDecoded: number;
  bytesPerDay: number;
  /** Bytes upstream declared, summed over answers that declared one; 0 where none did. */
  bytesWire: number;
  /** The average answer, which is what a narrower request changes. Null without a body read. */
  averageBodyBytes: number | null;
  /** Answers that carried no body because nothing had changed, as a share of requests. */
  notModifiedShare: number | null;
  events: number;
  /**
   * The ranking: bytes downloaded per event produced. Null where the window produced no events,
   * because a ratio over zero is not a large number, it is an unanswered question.
   */
  bytesPerEvent: number | null;
  /** Bytes per record parsed out of those answers, for a source whose events are rare by design. */
  bytesPerRecord: number | null;
};

export type TrafficReport = {
  since: string;
  days: number;
  reading: string;
  totals: { requests: number; bytesDecoded: number; bytesPerDay: number; events: number };
  sources: TrafficSource[];
  /** Sources that have collected in the window but recorded no traffic at all. */
  unmeasured: string[];
};

type Row = {
  source: string;
  requests: number | null;
  bytes_decoded: number | null;
  bytes_wire: number | null;
  not_modified: number | null;
  events_created: number | null;
  records_processed: number | null;
  attempts: number | null;
};

const ratio = (top: number, bottom: number): number | null => (bottom > 0 ? round(top / bottom, 1) : null);

export function traffic(db: Database, config: AppConfig, days: number, now = Date.now()): TrafficReport {
  const since = collectionWindowFrom(days, now);
  const rows = db
    .query<Row, [string]>(
      // Grouped over every outcome, not just success: a failed attempt downloaded what it
      // downloaded, and a source that is expensive mainly when it fails is one this is for.
      `SELECT source,
              SUM(requests) AS requests,
              SUM(bytes_decoded) AS bytes_decoded,
              SUM(bytes_wire) AS bytes_wire,
              SUM(not_modified) AS not_modified,
              SUM(events_created) AS events_created,
              SUM(records_processed) AS records_processed,
              SUM(attempts) AS attempts
       FROM source_collection_days
       WHERE day >= ?
       GROUP BY source`,
    )
    .all(dayFrom(since));
  // Named from the registry, so a source that has been retired keeps its rows and loses its place
  // in a list about what to change: `live_sources` is the table without them, and this is a report
  // about collectors that still run.
  const live = new Map(sourceJobs(db, config).map((job) => [job.id, job.label]));
  const measured: TrafficSource[] = [];
  const unmeasured: string[] = [];
  for (const row of rows) {
    const label = live.get(row.source);
    if (label === undefined) continue;
    const requests = row.requests ?? 0;
    const bytesDecoded = row.bytes_decoded ?? 0;
    const notModified = row.not_modified ?? 0;
    if (!requests && !notModified) {
      // Null rather than zero everywhere would read as "asks for nothing", which is the opposite of
      // "nobody has counted this yet". It is said once, as a list, instead of as a row of nulls.
      if (row.attempts) unmeasured.push(row.source);
      continue;
    }
    const bodies = requests - notModified;
    const events = row.events_created ?? 0;
    measured.push({
      id: row.source,
      label,
      requests,
      requestsPerDay: round(requests / days, 1),
      bytesDecoded,
      bytesPerDay: Math.round(bytesDecoded / days),
      bytesWire: row.bytes_wire ?? 0,
      averageBodyBytes: bodies > 0 ? Math.round(bytesDecoded / bodies) : null,
      notModifiedShare: requests > 0 ? round(notModified / requests, 3) : null,
      events,
      bytesPerEvent: ratio(bytesDecoded, events),
      bytesPerRecord: ratio(bytesDecoded, row.records_processed ?? 0),
    });
  }
  // Ranked by the ratio, with the sources that produced nothing from real traffic after the ones
  // that can be compared, and alphabetically inside each so the order is stable between runs.
  measured.sort((left, right) => {
    if (left.bytesPerEvent === null && right.bytesPerEvent === null) return left.id.localeCompare(right.id);
    if (left.bytesPerEvent === null) return 1;
    if (right.bytesPerEvent === null) return -1;
    return right.bytesPerEvent - left.bytesPerEvent || left.id.localeCompare(right.id);
  });
  const sum = (read: (source: TrafficSource) => number) => measured.reduce((total, row) => total + read(row), 0);
  const bytesDecoded = sum((row) => row.bytesDecoded);
  return {
    since,
    days,
    reading:
      "Ranked by bytesPerEvent: the download that is mostly discarded, not the largest one. A null " +
      "ratio is a window that produced no events, not a free source. bytesWire is what crossed the " +
      "link and bytesDecoded is what had to be held, so the two being far apart is compression " +
      "working and a memory question, not a network one. Requests count cheap change-probes and " +
      "exclude transport retries; notModifiedShare is the part of them that cost no body at all.",
    totals: {
      requests: sum((row) => row.requests),
      bytesDecoded,
      bytesPerDay: Math.round(bytesDecoded / days),
      events: sum((row) => row.events),
    },
    sources: measured,
    unmeasured: unmeasured.sort(),
  };
}
