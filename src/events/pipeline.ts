import type { Database } from "bun:sqlite";
import type { Destination } from "../config.js";
import { updateHypotheses } from "../hypotheses.js";
import { rebuildLifecycleDeadlines } from "../lifecycle.js";
import { type FactsDirty, updateModelFacts } from "../modelFacts.js";
import { measure } from "../runtime/metrics.js";
import { rememberStoryProjection, type StoryProjection, updateStories } from "../stories.js";
import { markNovelWeights } from "../weights.js";
import { prepareDeliveries } from "./batching.js";
import { persistCollection } from "./store.js";
import type { Collection } from "./types.js";

/**
 * What a saved collection leaves behind: the events it wrote, and the story projection it rebuilt.
 *
 * The projection is handed back rather than filed here because it is a cache in memory, and memory
 * is the one place a rolled-back transaction cannot reach. `saveCollection` runs inside the
 * poller's own transaction, so its commit is not the commit that decides anything; filing the
 * projection at the end of this function published a view of stories that the enclosing rollback
 * then erased from the database and nowhere else. The outermost caller owns that moment.
 */
export type SavedCollection = { events: number; projection: StoryProjection | null };

/**
 * Composes persistence and delivery preparation in one SQLite transaction. Each stage is timed as
 * pipeline.<stage>, across all sources: source.persist:<id> says which source was slow, these say
 * which stage. A stage that throws rolls its own measurement back with the transaction.
 */
/**
 * What this collection could have changed about Model Facts.
 *
 * Deliberately a superset. The stories are the ones carrying events this collection wrote; the
 * records are all of the collected source's, not only the rows that moved, because a record whose
 * body changed without producing an event still feeds the current-evidence half of the projection
 * and there is no cheaper honest way to know which did. Naming too many models costs a little work
 * and changes no answer; naming too few leaves a stale fact behind, so the error is taken on the
 * safe side.
 */
function dirtyStoryIds(db: Database, previousEventId: number): number[] {
  return db
    .query<{ story_id: number }, [number]>(
      "SELECT DISTINCT se.story_id FROM story_events se JOIN events e ON e.id=se.event_id WHERE e.id>?",
    )
    .all(previousEventId)
    .map((row) => row.story_id);
}

function factsDirty(db: Database, source: string, storyIds: readonly number[]): FactsDirty {
  const records = db
    .query<{ source: string; id: string }, [string]>("SELECT source,id FROM records WHERE source=?")
    .all(source);
  return { storyIds, records };
}

export function saveCollection(
  db: Database,
  collection: Collection,
  destinations: Destination[],
  now = new Date().toISOString(),
  vendorRoles: Record<string, string> = {},
  allSignalsRole?: string,
): SavedCollection {
  let projection: StoryProjection | null = null;
  const count = db.transaction(() => {
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
    let touchedStories: number[] = [];
    if (currentEventId > previousEventId) {
      projection = measure(db, "pipeline.stories", () => updateStories(db));
      touchedStories = dirtyStoryIds(db, previousEventId);
      // A hypothesis is a function of one story's timeline and the clock, so the stories that just
      // moved are the ones to recompute -- unless the projection was rebuilt from every event, which
      // is the one path that can move an old event into a different story. Then nothing is safe to
      // skip. The full pass was 256 ms on every collection that produced an event.
      measure(db, "pipeline.hypotheses", () =>
        updateHypotheses(db, projection?.rebuilt ? null : touchedStories, Date.parse(now)),
      );
      measure(db, "pipeline.lifecycle", () => rebuildLifecycleDeadlines(db, Date.parse(now)));
    }
    // Every collection, not only the ones that produced an event.
    //
    // This used to be gated on `initialized === null || currentEventId > previousEventId`, because a
    // full rebuild cost 1,343 ms and could not be afforded per collection. The gate had a cost of
    // its own: a record re-observed without producing an event still moves the current evidence, so
    // `updated_at` on a Model Fact lagged until the next unrelated event happened to trigger a
    // rebuild, and a full rebuild then disagreed with the stored rows. The equivalence test found
    // exactly that. Recomputing only the touched models costs single-digit milliseconds, so the
    // reason for the gate is gone and the staleness goes with it.
    measure(db, "pipeline.model-facts", () => updateModelFacts(db, factsDirty(db, collection.source, touchedStories)));
    // Leave event batches open until the delivery worker has filled any eligible summaries.
    measure(db, "pipeline.prepare-deliveries", () =>
      prepareDeliveries(db, Date.parse(now), vendorRoles, allSignalsRole, false),
    );
    return count;
  })();
  // Inside an enclosing transaction the projection is the caller's to file once its own commit
  // lands; standing alone, this was that commit.
  if (!db.inTransaction) {
    if (projection) rememberStoryProjection(db, projection);
    return { events: count, projection: null };
  }
  return { events: count, projection };
}
