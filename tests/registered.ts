import { loadConfig } from "../src/config.js";
import type { Collection } from "../src/events/types.js";
import { buildSourceRegistry } from "../src/sources/registry.js";
import { openDatabase } from "../src/storage/database.js";

const definitions = new Map(
  buildSourceRegistry(
    openDatabase(":memory:"),
    loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname }),
  ).map((definition) => [definition.id, definition]),
);

/** A collection as the poller hands it over: carrying the authority and vendor its registry entry declares. */
export function registered(collection: Collection): Collection {
  const definition = definitions.get(collection.source);
  if (!definition) return collection;
  return {
    ...collection,
    authority: definition.authority,
    ...(definition.vendor ? { vendor: definition.vendor } : {}),
  };
}
