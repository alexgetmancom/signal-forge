import type { Database } from "bun:sqlite";
import type { Destination } from "../config.js";
import { rebuildHypotheses } from "../hypotheses.js";
import { rebuildLifecycleDeadlines } from "../lifecycle.js";
import { rebuildModelFacts } from "../modelFacts.js";
import { measure } from "../runtime/metrics.js";
import { rememberStoryProjection, type StoryProjection, updateStories } from "../stories.js";
import { markNovelWeights } from "../weights.js";
import { prepareDeliveries } from "./batching.js";
import { persistCollection } from "./store.js";
import type { Collection } from "./types.js";

/**
 * Composes persistence and delivery preparation in one SQLite transaction. Each stage is timed as
 * pipeline.<stage>, across all sources: source.persist:<id> says which source was slow, these say
 * which stage. A stage that throws rolls its own measurement back with the transaction.
 */
export function saveCollection(
  db: Database,
  collection: Collection,
  destinations: Destination[],
  now = new Date().toISOString(),
  vendorRoles: Record<string, string> = {},
  allSignalsRole?: string,
): number {
  let projection: StoryProjection | null = null;
  const count = db.transaction(() => {
    const initialized = db
      .query<{ last_success: string | null }, [string]>("SELECT last_success FROM sources WHERE id=?")
      .get(collection.source)?.last_success;
    const previousEventId = Number(
      db.query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM events").get()?.id ?? 0,
    );
    // The ledger of parameter counts is memory a collector cannot hold, and its verdict belongs to
    // the same transaction as the snapshot and events it explains.
    const weighed = measure(db, "pipeline.weights", () => markNovelWeights(db, collection, now));
    const count = measure(db, "pipeline.persist", () => persistCollection(db, weighed, destinations, now));
    const currentEventId = Number(
      db.query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM events").get()?.id ?? 0,
    );
    if (currentEventId > previousEventId) {
      projection = measure(db, "pipeline.stories", () => updateStories(db));
      measure(db, "pipeline.hypotheses", () => rebuildHypotheses(db, Date.parse(now)));
      measure(db, "pipeline.lifecycle", () => rebuildLifecycleDeadlines(db, Date.parse(now)));
    }
    // Baseline observations have no event by design, but they still establish current Model Facts.
    if (initialized === null || initialized === undefined || currentEventId > previousEventId)
      measure(db, "pipeline.model-facts", () => rebuildModelFacts(db));
    // Leave event batches open until the delivery worker has filled any eligible summaries.
    measure(db, "pipeline.prepare-deliveries", () =>
      prepareDeliveries(db, Date.parse(now), vendorRoles, allSignalsRole, false),
    );
    return count;
  })();
  if (projection) rememberStoryProjection(db, projection);
  return count;
}
