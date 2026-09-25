import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { silentSources } from "../src/reports/silentSources.js";
import { buildSourceRegistry } from "../src/sources/registry.js";
import { openDatabase } from "../src/storage/database.js";

const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
const NOW = new Date("2026-09-25T12:00:00.000Z");

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

/** The three silences, which are three different repairs and read identically without `state`. */
test("a source never asked, one that never worked and one that stopped are told apart", () => {
  const { db, config, registry } = setup();
  const free = registry.filter((definition) => !definition.requiredCapabilities?.length);
  const [quiet, refused, never] = free as [(typeof free)[0], (typeof free)[0], (typeof free)[0]];
  // And one that waits on a credential nobody supplied, which is the commonest never_polled of all.
  const waiting = registry.find((definition) => definition.requiredCapabilities?.length);
  const long = new Date(NOW.getTime() - 40 * 86_400_000).toISOString();
  // Worked, then stopped: a collector to open.
  db.query("INSERT INTO sources(id,last_success,checked_at) VALUES(?,?,?)").run(quiet.id, long, long);
  // Asked, and has never once worked: whatever it answers with, it is not a silence to chase.
  db.query("INSERT INTO sources(id,checked_at,last_error,failures) VALUES(?,?,?,1)").run(
    refused.id,
    long,
    "Source returned HTTP 401",
  );
  // `never` has no row at all, which is what a source nothing has ever scheduled looks like.

  const report = silentSources(db, config, 7, NOW);
  const stateOf = (id: string) => report.find((row) => row.source === id)?.state;
  expect(stateOf(quiet.id)).toBe("went_quiet");
  expect(stateOf(refused.id)).toBe("never_succeeded");
  expect(stateOf(never.id)).toBe("never_polled");
  // Only the one that was never asked carries a reason, because only that one is not its collector.
  expect(report.find((row) => row.source === refused.id)?.reason).toBeNull();
  expect(report.find((row) => row.source === never.id)?.reason).toContain("scheduler");
  expect(report.find((row) => row.source === waiting?.id)?.reason).toContain("no credential");
  db.close();
});
