import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { sourceFailures } from "../src/reports/sourceFailures.js";
import { openDatabase } from "../src/storage/database.js";
import { listFailureEvidence, recordFailureEvidence } from "../src/storage/failureEvidence.js";

const CONFIG = loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname });

const minute = (index: number) => new Date(Date.parse("2026-09-24T00:00:00.000Z") + index * 60_000).toISOString();

test("only the most recent failures per source are kept, and the newest is first", () => {
  const db = openDatabase(":memory:");
  for (let index = 0; index < 30; index++)
    recordFailureEvidence(db, "arena", minute(index), "schema", { issueCount: index });
  const kept = listFailureEvidence(db, "arena");
  expect(kept.length).toBe(20);
  expect(kept[0]?.observedAt).toBe(minute(29));
  expect(kept.at(-1)?.observedAt).toBe(minute(10));
  // A noisy source does not crowd out a quiet one: the cap is per source, not per table.
  recordFailureEvidence(db, "claude-web", minute(0), "bot-protection", {});
  expect(listFailureEvidence(db, "claude-web").length).toBe(1);
  db.close();
});

test("evidence that cannot be serialised is dropped rather than raised", () => {
  const db = openDatabase(":memory:");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() => recordFailureEvidence(db, "arena", minute(0), "schema", cyclic)).not.toThrow();
  expect(listFailureEvidence(db, "arena")).toEqual([]);
  db.close();
});

test("one source's failures read back as kinds and structure", () => {
  const db = openDatabase(":memory:");
  const attempt = (at: string, outcome: { error: string; kind: string } | null) =>
    db
      .query("INSERT INTO source_collection_metrics(source,collected_at,success,error,failure_kind) VALUES(?,?,?,?,?)")
      .run("arena", at, outcome ? 0 : 1, outcome?.error ?? null, outcome?.kind ?? null);
  attempt(minute(0), { error: "arena models: 2 of 1083 entries did not match", kind: "schema" });
  attempt(minute(1), { error: "Collection degraded: arena retained 301 of 1083 records", kind: "degraded" });
  attempt(minute(2), null);
  recordFailureEvidence(db, "arena", minute(0), "schema", { rejected: 2, fields: { "#.displayName": 2 } });

  const report = sourceFailures(db, CONFIG, "arena", 7, Date.parse("2026-09-24T01:00:00.000Z"));
  expect(report.attempts).toBe(3);
  expect(report.failures).toBe(2);
  expect(report.kinds.map((kind) => kind.kind).sort()).toEqual(["degraded", "schema"]);
  expect(report.evidence[0]?.summary).toEqual({ rejected: 2, fields: { "#.displayName": 2 } });
  expect(report.registered).toBe(true);
  // A name the registry no longer asks for says so, rather than reading as a collector that broke.
  expect(sourceFailures(db, CONFIG, "designarena:logo", 7).registered).toBe(false);
  db.close();
});
