import type { Database } from "bun:sqlite";
import type { Destination } from "../config.js";
import { rebuildHypotheses } from "../hypotheses.js";
import { rebuildLifecycleDeadlines } from "../lifecycle.js";
import { rebuildModelFacts } from "../modelFacts.js";
import { rememberStoryProjection, type StoryProjection, updateStories } from "../stories.js";
import { prepareDeliveries } from "./batching.js";
import { persistCollection } from "./store.js";
import type { Collection } from "./types.js";

/** Composes persistence and delivery preparation in one SQLite transaction. */
export function saveCollection(
  db: Database,
  collection: Collection,
  destinations: Destination[],
  now = new Date().toISOString(),
  vendorRoles: Record<string, string> = {},
): number {
  let projection: StoryProjection | null = null;
  const count = db.transaction(() => {
    const initialized = db
      .query<{ last_success: string | null }, [string]>("SELECT last_success FROM sources WHERE id=?")
      .get(collection.source)?.last_success;
    const previousEventId = Number(
      db.query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM events").get()?.id ?? 0,
    );
    const count = persistCollection(db, collection, destinations, now);
    const currentEventId = Number(
      db.query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM events").get()?.id ?? 0,
    );
    if (currentEventId > previousEventId) {
      projection = updateStories(db);
      rebuildHypotheses(db, Date.parse(now));
      rebuildLifecycleDeadlines(db, Date.parse(now));
    }
    // Baseline observations have no event by design, but they still establish current Model Facts.
    if (initialized === null || initialized === undefined || currentEventId > previousEventId) rebuildModelFacts(db);
    // Leave event batches open until the delivery worker has filled any eligible summaries.
    prepareDeliveries(db, Date.parse(now), vendorRoles, false);
    return count;
  })();
  if (projection) rememberStoryProjection(db, projection);
  return count;
}
