import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config.js";
import { round } from "../numbers.js";
import { sourceJobs } from "../sources/registry.js";
import { collectionWindowFrom, dayFrom } from "../storage/collectionDays.js";

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
 *
 * Every reading here is a mean over the section's measured calls, not the worst one. `VmHWM` is
 * monotone and belongs to the process, so the climb from a fresh process's floor to its working
 * size is charged in full to whichever section happened to run during it -- and with the service
 * restarting nineteen times on 2026-10-02, that produced eight sources claiming 211-280 MB of
 * persistence against a median of 0.1 MB across all 214. Five of those eight were the same day.
 * Dropping the contaminated buckets is not open to this report: past `HOURLY_METRIC_DAYS` the fold
 * leaves one bucket per name per day, every day in a fourteen-day window had a restart, and
 * dropping whole days would leave nothing. A mean survives one such reading in proportion to how
 * many calls it is one of, which is what makes `anthropic` 0.4 MB over 601 calls rather than 261.
 * `measure` now charges a name's first call in a process nothing, so new readings carry less of
 * this, but rows already written keep it for the ninety days they live.
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
  /** Mean shared-process peak growth while a light collector ran; not uniquely attributed. */
  averageObservedDuringCollectionMb: number | null;
  /** Mean peak growth while the parent synchronously read and decoded a child answer. */
  averageAddedByDecodeMb: number | null;
  /** Mean peak growth from the parent's synchronous persistence transaction, in either lane. */
  averageAddedByPersistenceMb: number | null;
};

export type CollectionCostReport = {
  since: string;
  days: number;
  reading: string;
  sources: CollectionCostSource[];
};

const READING =
  "childPeakMb is the whole peak of a child that exited, worst and average. The parent still " +
  "reads and stores its answer. The three average readings are means over that section's " +
  "measured calls, not worst cases: the peak is the process's and is monotone, so one restart " +
  "charges a fresh process's whole climb to whichever section ran during it, and a mean is what " +
  "survives that in proportion to the calls it is one of. A mean over few calls is still mostly " +
  "that climb, so read it against collections. " +
  "averageObservedDuringCollectionMb is an upper bound on top of that: concurrent collectors can " +
  "all see one shared-process rise, so it cannot decide which source belongs in a child. " +
  "averageAddedByDecodeMb and averageAddedByPersistenceMb belong to the named source because " +
  "those sections run synchronously in the parent; those costs remain even for a child " +
  "collection. Null means that section did not run or was not measured.";

/** The child peaks of the window, per source, from the row each collection wrote. */
function childPeaks(db: Database, since: string): Map<string, { worst: number; average: number }> {
  return new Map(
    db
      .query<{ source: string; worst: number; average: number }, [string]>(
        `SELECT source,
                MAX(peak_rss_max) AS worst,
                SUM(peak_rss_total)/SUM(peak_rss_samples) AS average
         FROM source_collection_days
         WHERE day>=? AND peak_rss_samples>0
         GROUP BY source`,
      )
      .all(dayFrom(since))
      .map((row) => [row.source, { worst: row.worst, average: row.average }] as const),
  );
}

/**
 * Mean peak rise per call in parent sections; async collection overlaps, synchronous decode and
 * persistence do not.
 *
 * `peak_growth_kb` is the sum the bucket accumulated and `calls` is how many calls made it, so the
 * mean crosses the fold's hourly and daily buckets without caring which it is reading. `MAX` was
 * the first reading here and could not be kept: see this module's header for the restart that put
 * eight sources at a quarter of a gigabyte each.
 */
function parentGrowth(db: Database, since: string): Map<string, number> {
  return new Map(
    db
      .query<{ name: string; averageKb: number }, [string]>(
        `SELECT name,SUM(peak_growth_kb)*1.0/SUM(calls) AS averageKb
         FROM code_metrics
         WHERE bucket_start>=? AND
           (name LIKE 'source.collect:%' OR name LIKE 'source.decode:%' OR name LIKE 'source.persist:%')
         GROUP BY name
         HAVING SUM(calls)>0`,
      )
      .all(since)
      .map((row) => [row.name, row.averageKb] as const),
  );
}

/** How many times each source was collected in the window, successfully or not. */
function collectionCounts(db: Database, since: string): Map<string, number> {
  return new Map(
    db
      .query<{ source: string; runs: number }, [string]>(
        "SELECT source,SUM(attempts) AS runs FROM source_collection_days WHERE day>=? GROUP BY source",
      )
      .all(dayFrom(since))
      .map((row) => [row.source, row.runs] as const),
  );
}

/**
 * What every configured source costs, worst first.
 *
 * The names come from the registry, never from the tables: `source_collection_days` keeps a row
 * for every source that ever ran, so a `GROUP BY` over it reports on sources that were retired.
 */
export function collectionCost(db: Database, config: AppConfig, days = 7, now = Date.now()): CollectionCostReport {
  if (!Number.isInteger(days) || days < 1 || days > 90)
    throw new Error("Collection cost days must be between 1 and 90");
  // Whole days, because the collection counts are read from a fold that holds days; the parent
  // sections below are then measured over the same bound rather than a slightly narrower one.
  const since = collectionWindowFrom(days, now);
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
        averageObservedDuringCollectionMb: collect === undefined ? null : round(collect / 1024, 1),
        averageAddedByDecodeMb: decode === undefined ? null : round(decode / 1024, 1),
        averageAddedByPersistenceMb: persist === undefined ? null : round(persist / 1024, 1),
      };
    })
    .sort(
      (left, right) =>
        Math.max(right.averageAddedByDecodeMb ?? 0, right.averageAddedByPersistenceMb ?? 0) -
          Math.max(left.averageAddedByDecodeMb ?? 0, left.averageAddedByPersistenceMb ?? 0) ||
        (right.averageObservedDuringCollectionMb ?? 0) - (left.averageObservedDuringCollectionMb ?? 0) ||
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
