import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config.js";
import { round } from "../numbers.js";
import { sourceJobs } from "../sources/registry.js";

/**
 * What each source costs the machine it actually runs on.
 *
 * `source-cost` answered this by running every light collector against a copy of production on a
 * laptop, once, which is the wrong machine and the wrong moment: it cannot see a feed that grew over
 * the weekend, and a source added on Tuesday has no number until somebody remembers to ask. Both
 * halves of the answer are now recorded by production itself.
 *
 * A light source is collected in this process; a heavy source is collected in a child. The child
 * reports its own peak. The parent still reads and stores that child's answer, so persistence is
 * measured for both lanes. Collectors overlap while awaiting network I/O, so their peak growth is
 * an upper bound. Reading and decoding a child answer and persisting any answer run synchronously
 * on the parent's event loop, so their growth belongs to the named source.
 *
 * No source-specific move is prescribed from overlapping collection measurements. The same rise
 * was charged to three light collectors and one heavy source's persistence on 2026-09-27.
 */
type CollectionCostSource = {
  id: string;
  label: string;
  /** Where the collection runs: a child that ends, or this process. */
  lane: "child" | "in process";
  collections: number;
  /** The worst and the usual size a child reached; null for a source collected in this process. */
  childPeakMb: number | null;
  averageChildPeakMb: number | null;
  /** Shared-process peak growth observed while a light collector ran; not uniquely attributed. */
  observedDuringCollectionMb: number | null;
  /** Peak growth added while the parent synchronously read and decoded a child answer. */
  addedByDecodeMb: number | null;
  /** Peak growth added by the parent's synchronous persistence transaction, in either lane. */
  addedByPersistenceMb: number | null;
};

export type CollectionCostReport = {
  since: string;
  days: number;
  reading: string;
  sources: CollectionCostSource[];
};

const READING =
  "childPeakMb is the whole peak of a child that exited. The parent still reads and stores its " +
  "answer. observedDuringCollectionMb is an upper bound: concurrent collectors can all see one " +
  "shared-process rise, so it cannot decide which source belongs in a child. " +
  "addedByDecodeMb and addedByPersistenceMb belong to the named source because those sections " +
  "run synchronously in the parent; those costs remain even for a child collection. Do not add " +
  "worst readings from different attempts. " +
  "Null means that section did not run or was not measured.";

/** The child peaks of the window, per source, from the row each collection wrote. */
function childPeaks(db: Database, since: string): Map<string, { worst: number; average: number }> {
  return new Map(
    db
      .query<{ source: string; worst: number; average: number }, [string]>(
        `SELECT source,MAX(peak_rss_mb) AS worst,AVG(peak_rss_mb) AS average
         FROM source_collection_metrics
         WHERE collected_at>=? AND peak_rss_mb IS NOT NULL
         GROUP BY source`,
      )
      .all(since)
      .map((row) => [row.source, { worst: row.worst, average: row.average }] as const),
  );
}

/** Peak rises in parent sections; async collection overlaps, synchronous decode and persistence do not. */
function parentGrowth(db: Database, since: string): Map<string, number> {
  return new Map(
    db
      .query<{ name: string; worstKb: number }, [string]>(
        `SELECT name,MAX(max_peak_growth_kb) AS worstKb
         FROM code_metrics
         WHERE bucket_start>=? AND
           (name LIKE 'source.collect:%' OR name LIKE 'source.decode:%' OR name LIKE 'source.persist:%')
         GROUP BY name`,
      )
      .all(since)
      .map((row) => [row.name, row.worstKb] as const),
  );
}

/** How many times each source was collected in the window, successfully or not. */
function collectionCounts(db: Database, since: string): Map<string, number> {
  return new Map(
    db
      .query<{ source: string; runs: number }, [string]>(
        "SELECT source,COUNT(*) AS runs FROM source_collection_metrics WHERE collected_at>=? GROUP BY source",
      )
      .all(since)
      .map((row) => [row.source, row.runs] as const),
  );
}

/**
 * What every configured source costs, worst first.
 *
 * The names come from the registry, never from the tables: `source_collection_metrics` keeps a row
 * for every source that ever ran, so a `GROUP BY` over it reports on sources that were retired.
 */
export function collectionCost(db: Database, config: AppConfig, days = 7, now = Date.now()): CollectionCostReport {
  if (!Number.isInteger(days) || days < 1 || days > 90)
    throw new Error("Collection cost days must be between 1 and 90");
  const since = new Date(now - days * 24 * 3_600_000).toISOString();
  const peaks = childPeaks(db, since);
  const growth = parentGrowth(db, since);
  const counts = collectionCounts(db, since);
  const sources = sourceJobs(db, config)
    .map<CollectionCostSource>((job) => {
      const peak = peaks.get(job.id);
      const collect = job.heavy ? undefined : growth.get(`source.collect:${job.id}`);
      const decode = job.heavy ? growth.get(`source.decode:${job.id}`) : undefined;
      const persist = growth.get(`source.persist:${job.id}`);
      return {
        id: job.id,
        label: job.label,
        lane: job.heavy ? "child" : "in process",
        collections: counts.get(job.id) ?? 0,
        childPeakMb: peak ? round(peak.worst, 1) : null,
        averageChildPeakMb: peak ? round(peak.average, 1) : null,
        observedDuringCollectionMb: collect === undefined ? null : round(collect / 1024, 1),
        addedByDecodeMb: decode === undefined ? null : round(decode / 1024, 1),
        addedByPersistenceMb: persist === undefined ? null : round(persist / 1024, 1),
      };
    })
    .sort(
      (left, right) =>
        Math.max(right.addedByDecodeMb ?? 0, right.addedByPersistenceMb ?? 0) -
          Math.max(left.addedByDecodeMb ?? 0, left.addedByPersistenceMb ?? 0) ||
        (right.observedDuringCollectionMb ?? 0) - (left.observedDuringCollectionMb ?? 0) ||
        (right.childPeakMb ?? 0) - (left.childPeakMb ?? 0) ||
        left.id.localeCompare(right.id),
    );
  return {
    since,
    days,
    reading: READING,
    sources,
  };
}
