import type { Database } from "bun:sqlite";
import type { Destination } from "../config.js";
import { prepareDeliveries } from "./batching.js";
import { persistCollection } from "./store.js";
import type { Collection } from "./types.js";

/** Composes persistence and delivery preparation in one SQLite transaction. */
export function saveCollection(
  db: Database,
  collection: Collection,
  destinations: Destination[],
  now = new Date().toISOString(),
  reportBaseUrl?: string,
  vendorRoles: Record<string, string> = {},
): number {
  return db.transaction(() => {
    const count = persistCollection(db, collection, destinations, now);
    prepareDeliveries(db, Date.parse(now), reportBaseUrl, vendorRoles);
    return count;
  })();
}
