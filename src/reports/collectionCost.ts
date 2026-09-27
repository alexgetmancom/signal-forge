import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config.js";
import { round } from "../numbers.js";
import { WORTH_A_CHILD_MB } from "../runtime/peak.js";
import { sourceJobs } from "../sources/registry.js";

/**
 * What each source costs the machine it actually runs on.
 *
 * `source-cost` answered this by running every light collector against a copy of production on a
 * laptop, once, which is the wrong machine and the wrong moment: it cannot see a feed that grew over
 * the weekend, and a source added on Tuesday has no number until somebody remembers to ask. Both
 * halves of the answer are now recorded by production itself.
 *
 * A light source is collected in this process, so the registry's `measure` weighs it: `code_metrics`
 * keeps what each collection added to the peak, and the peak is never given back, so that growth is
 * floor this service keeps for the rest of the boot. A heavy source is collected in a process that
 * ends -- which is the whole point of it, and also why nothing here can measure it -- so the child
 * reads its own high-water mark before it exits and hands the number back with its answer.
 *
 * The two columns are not the same measurement and are deliberately not added together. A child's
 * peak is the whole size of a process that no longer exists and costs this service nothing lasting;
 * a light source's growth is what it added to the process that stays. Only the second is a reason to
 * change anything, which is why only it is compared against the threshold.
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
  /** What one collection added to this process's floor at worst, and over the whole window. */
  addedToTheFloorMb: number | null;
  addedOverTheWindowMb: number | null;
};

export type CollectionCostReport = {
  since: string;
  days: number;
  worthAChildMb: number;
  reading: string;
  /** Light sources whose worst collection added more to the floor than a child is worth. */
  shouldBeCollectedInAChild: string[];
  sources: CollectionCostSource[];
};

const READING =
  "childPeakMb is the whole resident size a child reached and then took with it when it exited, so " +
  "it costs this service nothing lasting -- it is here to say which collections are large, not which " +
  "are a problem. addedToTheFloorMb is the other thing entirely: what a collection added to the " +
  "high-water mark of the process that stays running, which is never given back and is what an OOM " +
  "kill is decided by. Only that number is compared against worthAChildMb, and a source over it " +
  "belongs in the heavy lane. Both are absent where nothing has been recorded yet: a source that has " +
  "not run in the window, or one whose collections predate the columns (2026-09-27).";

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

/**
 * What each collector added to this process's peak, per source, from the section that timed it.
 *
 * The section is named `source.collect:<id>` by the registry, which is why the id is cut off the name
 * rather than joined on: there is no column holding it, and a `LIKE` over a name is cheaper than
 * every report growing a table to hold what the name already says.
 */
function inProcessGrowth(db: Database, since: string): Map<string, { worstKb: number; totalKb: number }> {
  return new Map(
    db
      .query<{ name: string; worstKb: number; totalKb: number }, [string]>(
        `SELECT name,MAX(max_peak_growth_kb) AS worstKb,SUM(peak_growth_kb) AS totalKb
         FROM code_metrics
         WHERE bucket_start>=? AND name LIKE 'source.collect:%'
         GROUP BY name`,
      )
      .all(since)
      .map(
        (row) => [row.name.slice("source.collect:".length), { worstKb: row.worstKb, totalKb: row.totalKb }] as const,
      ),
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
  const growth = inProcessGrowth(db, since);
  const counts = collectionCounts(db, since);
  const sources = sourceJobs(db, config)
    .map<CollectionCostSource>((job) => {
      const peak = peaks.get(job.id);
      const added = job.heavy ? undefined : growth.get(job.id);
      return {
        id: job.id,
        label: job.label,
        lane: job.heavy ? "child" : "in process",
        collections: counts.get(job.id) ?? 0,
        childPeakMb: peak ? round(peak.worst, 1) : null,
        averageChildPeakMb: peak ? round(peak.average, 1) : null,
        addedToTheFloorMb: added ? round(added.worstKb / 1024, 1) : null,
        addedOverTheWindowMb: added ? round(added.totalKb / 1024, 1) : null,
      };
    })
    .sort(
      (left, right) =>
        (right.addedToTheFloorMb ?? 0) - (left.addedToTheFloorMb ?? 0) ||
        (right.childPeakMb ?? 0) - (left.childPeakMb ?? 0) ||
        left.id.localeCompare(right.id),
    );
  return {
    since,
    days,
    worthAChildMb: WORTH_A_CHILD_MB,
    reading: READING,
    shouldBeCollectedInAChild: sources
      .filter((source) => (source.addedToTheFloorMb ?? 0) >= WORTH_A_CHILD_MB)
      .map((source) => `${source.id} (${source.addedToTheFloorMb} MB)`),
    sources,
  };
}
