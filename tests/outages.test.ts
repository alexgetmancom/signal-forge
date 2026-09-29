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

/**
 * The pacing group with the most members, whatever order the registry happens to be built in.
 *
 * This used to take whichever group the first paced source belonged to, which is a fact about the
 * order of the packs rather than about pacing: adding one paced source to a pack that is assembled
 * early left the test asserting things about a group of one, and it failed for a reason that had
 * nothing to do with outages.
 */
function largestPacingGroup(registry: readonly { pace?: { group: string } | null }[]): string {
  const counts = new Map<string, number>();
  for (const definition of registry)
    if (definition.pace) counts.set(definition.pace.group, (counts.get(definition.pace.group) ?? 0) + 1);
  return [...counts].sort(([, a], [, b]) => b - a)[0]?.[0] ?? "";
}

test("sources sharing a pacing group report as one host, with the minutes they failed together", () => {
  const { db, config, registry } = setup();
  const group = largestPacingGroup(registry);
  const paced = registry.filter((definition) => definition.pace?.group === group).slice(0, 3);
  expect(paced.length).toBeGreaterThanOrEqual(2);
  const together = paced;
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

test("a member that failed alone carries no share of the outage it is grouped with", () => {
  const { db, config, registry } = setup();
  const group = largestPacingGroup(registry);
  const together = registry.filter((definition) => definition.pace?.group === group);
  expect(together.length).toBeGreaterThanOrEqual(3);
  const minute = (offsetHours: number) => new Date(NOW - offsetHours * 3_600_000).toISOString();
  // Two of the host failed inside one minute. The third failed on its own, hours away from them, and
  // is in the group only because a pacing group is a host: `broken` reads `concurrent` to tell the
  // two that took part in an outage from the one that happened to share a rate limit with them.
  const [first, second, third] = together as [(typeof together)[0], (typeof together)[0], (typeof together)[0]];
  anAttempt(db, first.id, reset, minute(4));
  anAttempt(db, second.id, reset, minute(4));
  anAttempt(db, third.id, reset, minute(9));

  const [outage] = outages(db, config, 7, NOW);
  const shareOf = (id: string) => outage?.members.find((member) => member.id === id)?.concurrent;
  expect(shareOf(first.id)).toBe(1);
  expect(shareOf(second.id)).toBe(1);
  expect(shareOf(third.id)).toBe(0);
});
