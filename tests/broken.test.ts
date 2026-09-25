import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { brokenReport } from "../src/reports/broken.js";
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

test("a source two readings agree on is listed above a source only one found", () => {
  const { db, config, registry } = setup();
  const paced = registry.filter((definition) => definition.pace);
  const group = paced[0]?.pace?.group as string;
  const together = paced.filter((definition) => definition.pace?.group === group).slice(0, 2);
  expect(together.length).toBe(2);

  // Two of one host failing inside the same minute, often enough to be a rate as well as an outage.
  const minute = (offsetHours: number) => new Date(NOW - offsetHours * 3_600_000).toISOString();
  for (const definition of together)
    for (const hours of [2, 4, 6, 8, 10, 12, 14, 16]) anAttempt(db, definition.id, reset, minute(hours));

  const report = brokenReport(db, config, 3, NOW);
  const both = report.readings.filter((row) => row.readings.length > 1);
  expect(both.length).toBeGreaterThan(0);
  expect(both[0]?.readings).toContain("outage");
  // The roll-up is sorted by how many readings agree, which is the fact no single command has.
  expect(report.readings[0]?.readings.length).toBeGreaterThanOrEqual(report.readings.at(-1)?.readings.length ?? 0);
});

test("each section says which reading it is, and the headline counts all four", () => {
  const { db, config } = setup();
  const report = brokenReport(db, config, 3, NOW);
  // A database nobody has collected into: every enabled source is an absence and nothing else.
  expect(report.headline).toContain("gone quiet");
  expect(report.headline).not.toContain("host failing as one");
  expect(report.now.reading).toContain("the present");
  expect(report.silent.reading).toContain("an absence");
  expect(report.flaky.reading).toContain("a rate");
  expect(report.outages.reading).toContain("a correlation");
});

test("the correlation is read over a week even when the rate is read over three days", () => {
  const { db, config, registry } = setup();
  const paced = registry.filter((definition) => definition.pace);
  const group = paced[0]?.pace?.group as string;
  const together = paced.filter((definition) => definition.pace?.group === group).slice(0, 2);
  // Five days back: outside the three-day rate window, inside the week an outage is read over.
  const at = new Date(NOW - 5 * 86_400_000).toISOString();
  for (const definition of together) anAttempt(db, definition.id, reset, at);

  const report = brokenReport(db, config, 3, NOW);
  expect(report.flaky.sources).toEqual([]);
  expect(report.outages.groups[0]?.concurrentMinutes).toBe(1);
});

test("a group that never failed together is not an outage, however much it failed", () => {
  const { db, config, registry } = setup();
  const paced = registry.filter((definition) => definition.pace);
  const group = paced[0]?.pace?.group as string;
  const together = paced.filter((definition) => definition.pace?.group === group).slice(0, 2);
  // Plenty of failures, never in the same minute: a grouping, not a cause.
  for (const [index, definition] of together.entries())
    for (const hours of [2, 4, 6])
      anAttempt(db, definition.id, reset, new Date(NOW - (hours * 3_600_000 + index * 60_000)).toISOString());

  const report = brokenReport(db, config, 3, NOW);
  expect(report.outages.groups).toEqual([]);
  expect(report.headline).not.toContain("failing as one");
  expect(report.readings.every((row) => !row.readings.includes("outage"))).toBe(true);
});
