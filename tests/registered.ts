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

/**
 * A collection as the poller hands it over: carrying the authority, the evidence contract and the
 * vendor its registry entry declares. A source the fixture registry does not know is handed over as
 * it came, which is what an unregistered collection gets in production too -- the least of everything.
 */
export function registered(collection: Collection): Collection {
  const definition = definitions.get(collection.source);
  if (!definition) return collection;
  return {
    ...collection,
    authority: definition.authority,
    evidence: definition.evidence,
    confidence: definition.confidence,
    ...(definition.vendor ? { vendor: definition.vendor } : {}),
  };
}
