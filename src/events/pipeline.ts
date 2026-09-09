import type { Database } from "bun:sqlite";
import type { Destination } from "../config.js";
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
    const previousEventId = Number(
      db.query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM events").get()?.id ?? 0,
    );
    const count = persistCollection(db, collection, destinations, now);
    const currentEventId = Number(
      db.query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM events").get()?.id ?? 0,
    );
    if (currentEventId > previousEventId) projection = updateStories(db);
    prepareDeliveries(db, Date.parse(now), vendorRoles);
    return count;
  })();
  if (projection) rememberStoryProjection(db, projection);
  return count;
}
