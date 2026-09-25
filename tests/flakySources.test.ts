import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { flakySources } from "../src/reports/flakySources.js";
import { buildSourceRegistry } from "../src/sources/registry.js";
import { openDatabase } from "../src/storage/database.js";

const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
const NOW = Date.parse("2026-09-25T12:00:00.000Z");

function setup() {
  const db = openDatabase(":memory:");
  const base = loadConfig({ CONFIG_PATH: configPath });
  const enabled = buildSourceRegistry(db, base).map((definition) => definition.id);
  const config = { ...base, sourceEnabled: Object.fromEntries(enabled.map((id) => [id, true])) };
  let clock = NOW - 36 * 3_600_000;
  const attempt = (source: string, ok: boolean) => {
    clock += 60_000;
    db.query("INSERT INTO source_collection_metrics(source,collected_at,success) VALUES(?,?,?)").run(
      source,
      new Date(clock).toISOString(),
      ok ? 1 : 0,
    );
  };
  return { db, config, attempt, enabled };
}

test("a source that fails most attempts but not all is reported, with its rate", () => {
  const { db, config, attempt, enabled } = setup();
  const source = enabled[0] as string;
  // Two failures in three, and a success every third: never silent, and red only if you look then.
  for (let round = 0; round < 6; round++) {
    attempt(source, false);
    attempt(source, false);
    attempt(source, true);
  }
  const [flaky] = flakySources(db, config, 3, NOW);
  expect(flaky?.id).toBe(source);
  expect([flaky?.failures, flaky?.attempts]).toEqual([12, 18]);
  expect(flaky?.failureRate).toBe(0.67);
  expect(flaky?.state).toBe("flaky");
  db.close();
});

test("too few attempts is not a rate, and a healthy source is not a finding", () => {
  const { db, config, attempt, enabled } = setup();
  const young = enabled[0] as string;
  const healthy = enabled[1] as string;
  // Three of four failed, but four attempts cannot tell a fault from an upstream's bad afternoon.
  attempt(young, false);
  attempt(young, false);
  attempt(young, false);
  attempt(young, true);
  for (let round = 0; round < 20; round++) attempt(healthy, true);
  expect(flakySources(db, config, 3, NOW)).toEqual([]);
  db.close();
});

test("nothing succeeding at all is called failing, and a source outside the registry is not called anything", () => {
  const { db, config, attempt, enabled } = setup();
  const source = enabled[0] as string;
  for (let round = 0; round < 10; round++) attempt(source, false);
  // A retired collector keeps its metrics, and reading them as a fault is the mistake the reports
  // exist to avoid: the registry decides who is still being asked.
  for (let round = 0; round < 10; round++) attempt("retired-collector", false);

  const found = flakySources(db, config, 3, NOW);
  expect(found.map((entry) => entry.id)).toEqual([source]);
  expect(found[0]?.state).toBe("failing");
  expect(found[0]?.quietHours).toBeNull();
  db.close();
});

/**
 * The measured shape of `arena` on 2026-09-25: of 103 failures in three days, 84 were this service's
 * own shrink guard refusing a short answer. One rate called that a collector 58% broken.
 */
test("a guard refusing an answer is counted, named, and kept out of the fault rate", () => {
  const { db, config, enabled } = setup();
  const source = enabled[0] as string;
  let clock = NOW - 30 * 3_600_000;
  const record = (outcome: { error: string; kind: string } | null) => {
    clock += 60_000;
    db.query(
      "INSERT INTO source_collection_metrics(source,collected_at,success,error,failure_kind) VALUES(?,?,?,?,?)",
    ).run(source, new Date(clock).toISOString(), outcome ? 0 : 1, outcome?.error ?? null, outcome?.kind ?? null);
  };
  for (let index = 0; index < 60; index++) record(null);
  for (let index = 0; index < 84; index++)
    record({ error: "Collection degraded: arena retained 301 of 1083 records", kind: "degraded" });
  for (let index = 0; index < 19; index++)
    record({ error: "arena models: 1 of 1083 entries did not match the schema", kind: "schema" });

  const [entry] = flakySources(db, config, 3, NOW);
  expect(entry?.failures).toBe(103);
  expect(entry?.refusedByGuard).toBe(84);
  expect(entry?.faults).toBe(19);
  expect(entry?.failureRate).toBe(0.63);
  expect(entry?.faultRate).toBe(0.12);
  expect(entry?.kinds).toEqual({ degraded: 84, schema: 19 });
  db.close();
});

test("a source whose failures are all the guard is guarded rather than broken", () => {
  const { db, config, enabled } = setup();
  const source = enabled[0] as string;
  let clock = NOW - 30 * 3_600_000;
  const record = (outcome: { error: string; kind: string } | null) => {
    clock += 60_000;
    db.query(
      "INSERT INTO source_collection_metrics(source,collected_at,success,error,failure_kind) VALUES(?,?,?,?,?)",
    ).run(source, new Date(clock).toISOString(), outcome ? 0 : 1, outcome?.error ?? null, outcome?.kind ?? null);
  };
  for (let index = 0; index < 10; index++) record(null);
  for (let index = 0; index < 20; index++)
    record({ error: "Collection degraded: arena retained 301 of 1083 records", kind: "degraded" });
  expect(flakySources(db, config, 3, NOW)[0]?.state).toBe("guarded");
  db.close();
});

test("failures written before the kind existed are still told apart by what the guard writes", () => {
  const { db, config, enabled, attempt } = setup();
  const source = enabled[0] as string;
  for (let index = 0; index < 10; index++) attempt(source, true);
  // Rows from before migration 052 carry no kind at all, and the report has to stay honest about
  // them rather than count the guard's own refusals as faults for ninety days.
  db.query("INSERT INTO source_collection_metrics(source,collected_at,success,error) VALUES(?,?,0,?)").run(
    source,
    new Date(NOW - 3_600_000).toISOString(),
    "Collection degraded: arena retained 301 of 1083 records",
  );
  db.query("INSERT INTO source_collection_metrics(source,collected_at,success,error) VALUES(?,?,0,?)").run(
    source,
    new Date(NOW - 1_800_000).toISOString(),
    "Collection failed: response did not match the schema (ZodError)",
  );
  const [entry] = flakySources(db, config, 3, NOW);
  expect(entry?.kinds).toEqual({ degraded: 1, unrecorded: 1 });
  expect(entry?.refusedByGuard).toBe(1);
  expect(entry?.faults).toBe(1);
  db.close();
});
