import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { collectionDegraded } from "../src/failure.js";
import { flakySources } from "../src/reports/flakySources.js";
import { buildSourceRegistry } from "../src/sources/registry.js";
import { openDatabase } from "../src/storage/database.js";
import { anAttempt } from "./fixtures/build.js";

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
    anAttempt(
      db,
      source,
      ok ? null : { error: "Source returned HTTP 500", kind: "http" },
      new Date(clock).toISOString(),
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
    anAttempt(db, source, outcome, new Date(clock).toISOString());
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
    anAttempt(db, source, outcome, new Date(clock).toISOString());
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
  anAttempt(
    db,
    source,
    { error: "Collection degraded: arena retained 301 of 1083 records" },
    new Date(NOW - 3_600_000).toISOString(),
  );
  anAttempt(
    db,
    source,
    { error: "Collection failed: response did not match the schema (ZodError)" },
    new Date(NOW - 1_800_000).toISOString(),
  );
  const [entry] = flakySources(db, config, 3, NOW);
  expect(entry?.kinds).toEqual({ degraded: 1, before_kinds_were_recorded: 1 });
  expect(entry?.refusedByGuard).toBe(1);
  expect(entry?.faults).toBe(1);
  db.close();
});

test("failures written before kinds were recorded are still told apart by the guard's own sentence", () => {
  const { db, config, enabled } = setup();
  const source = enabled[0] as string;
  let clock = NOW - 30 * 3_600_000;
  // No kind at all, as every row written before the column was: the sentence is all there is.
  const old = (error: string) => {
    clock += 60_000;
    anAttempt(db, source, { error }, new Date(clock).toISOString());
  };
  for (let index = 0; index < 60; index++) {
    clock += 60_000;
    anAttempt(db, source, null, new Date(clock).toISOString());
  }
  for (let index = 0; index < 5; index++) old(collectionDegraded("arena", 1083, 301).message);
  for (let index = 0; index < 2; index++) old("something that was never given a kind");
  const [entry] = flakySources(db, config, 3, NOW);
  // The wording the guard writes now is the wording the recognition reads: change one and this fails.
  expect(entry?.kinds).toEqual({ degraded: 5, before_kinds_were_recorded: 2 });
  db.close();
});
