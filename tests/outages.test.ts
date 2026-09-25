import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { outages } from "../src/reports/outages.js";
import { buildSourceRegistry } from "../src/sources/registry.js";
import { openDatabase } from "../src/storage/database.js";
import { anAttempt } from "./fixtures/build.js";

const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
const NOW = Date.parse("2026-09-25T12:00:00.000Z");

function setup() {
  const db = openDatabase(":memory:");
  const base = loadConfig({ CONFIG_PATH: configPath });
  const registry = buildSourceRegistry(db, base);
  const config = {
    ...base,
    sourceEnabled: Object.fromEntries(registry.map((definition) => [definition.id, true])),
  };
  return { db, config, registry: buildSourceRegistry(db, config) };
}

const reset = { error: "Collection failed: network error (Error, ECONNRESET)", kind: "network" };

test("sources sharing a pacing group report as one host, with the minutes they failed together", () => {
  const { db, config, registry } = setup();
  const paced = registry.filter((definition) => definition.pace).slice(0, 3);
  expect(paced.length).toBeGreaterThanOrEqual(2);
  const group = paced[0]?.pace?.group as string;
  const together = paced.filter((definition) => definition.pace?.group === group);
  expect(together.length).toBeGreaterThanOrEqual(2);

  // The shape measured on production: three of a group failing inside one minute, twice, plus a
  // scatter of single failures that are nobody's evidence of anything.
  const minute = (offsetHours: number) => new Date(NOW - offsetHours * 3_600_000).toISOString();
  for (const definition of together) {
    anAttempt(db, definition.id, reset, minute(5));
    anAttempt(db, definition.id, reset, minute(3));
  }
  anAttempt(db, together[0]?.id as string, reset, minute(20));

  const [entry] = outages(db, config, 7, NOW).filter((row) => row.group === group);
  expect(entry?.paced).toBe(true);
  expect(entry?.sources).toBe(together.length);
  expect(entry?.failures).toBe(together.length * 2 + 1);
  expect(entry?.concurrentMinutes).toBe(2);
  expect(entry?.concurrentFailures).toBe(together.length * 2);
  expect(entry?.kinds).toEqual({ network: together.length * 2 + 1 });
  db.close();
});

test("one source failing alone is a source, not an outage", () => {
  const { db, config, registry } = setup();
  const only = registry[0]?.id as string;
  for (let index = 0; index < 20; index++) anAttempt(db, only, reset, new Date(NOW - index * 3_600_000).toISOString());
  expect(outages(db, config, 7, NOW)).toEqual([]);
  db.close();
});

test("a retired source does not drag its group into a report", () => {
  const { db, config } = setup();
  anAttempt(db, "a-source-nobody-collects-any-more", reset, new Date(NOW - 3_600_000).toISOString());
  anAttempt(db, "another-retired-one", reset, new Date(NOW - 3_600_000).toISOString());
  expect(outages(db, config, 7, NOW)).toEqual([]);
  db.close();
});
