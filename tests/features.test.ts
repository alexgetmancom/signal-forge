import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../src/config.js";
import { FEATURE_IDS, featureState, featureStates } from "../src/features.js";
import { featureReport } from "../src/reports/features.js";
import { openDatabase } from "../src/storage/database.js";

const base = { destinations: [], featureEnabled: {} } as unknown as AppConfig;

test("a feature is on by default, off when the config says so, and unavailable beats both", () => {
  expect(featureState(base, "weekly-recap").state).toBe("on");
  expect(
    featureState({ ...base, featureEnabled: { "weekly-recap": false } } as AppConfig, "weekly-recap"),
  ).toMatchObject({ state: "off", reason: "featureEnabled says false" });
  // Asked for and impossible is not the same answer as not asked for: the reason names what is missing.
  expect(
    featureState({ ...base, featureEnabled: { "jev-verdicts": true } } as AppConfig, "jev-verdicts"),
  ).toMatchObject({ state: "unavailable", reason: "TYPESAFE_API_KEY is not configured" });
});

test("the two retired morning lists read as off rather than as broken", () => {
  expect(featureState(base, "daily-recap").state).toBe("off");
  expect(featureState(base, "daily-news").state).toBe("off");
  // Retired deliberately, so the reason it was retired travels with the switch.
  expect(featureState(base, "daily-recap").note).toContain("2026-09-26");
});

test("a featureEnabled key that names no feature is reported rather than ignored", () => {
  const db = openDatabase(":memory:");
  const config = { ...base, featureEnabled: { "daily-digest": false } } as AppConfig;
  expect(featureReport(db, config).unknown).toEqual(["daily-digest"]);
});

test("every feature reports the trace its last activity was read from", () => {
  const db = openDatabase(":memory:");
  const report = featureReport(db, base);
  expect(report.features.map((feature) => feature.id).sort()).toEqual([...FEATURE_IDS].sort());
  for (const feature of report.features) expect(feature.activity.length).toBeGreaterThan(0);
  // An empty database has nothing to read, and says null rather than today.
  expect(report.features.every((feature) => feature.lastActivity === null)).toBe(true);
});

test("a recap that ran is what the weekly feature's last activity reads", () => {
  const db = openDatabase(":memory:");
  db.query(
    "INSERT INTO batches(source,digest,ready_at,kind,context_json) VALUES('weekly-recap',0,'2026-09-13T18:00:00.000Z','weekly_recap','{}')",
  ).run();
  const weekly = featureReport(db, base, new Date("2026-09-20T18:00:00.000Z")).features.find(
    (feature) => feature.id === "weekly-recap",
  );
  expect(weekly).toMatchObject({ lastActivity: "2026-09-13T18:00:00.000Z", quietDays: 7 });
});

/**
 * A feature in the list that no code asks about is documentation that lies: the switch is offered,
 * an operator sets it, and the behaviour keeps running. The gate for that is this test.
 */
test("every listed feature is asked about somewhere in src", () => {
  const sources: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && path !== "src/features.ts") sources.push(readFileSync(path, "utf8"));
    }
  };
  walk("src");
  const asked = sources.join("\n");
  for (const id of FEATURE_IDS) expect(asked).toContain(`"${id}"`);
});

test("states are listed in the order the sections are read", () => {
  expect(featureStates(base).map((feature) => feature.section)).toEqual([
    ...Array(4).fill("periodic"),
    ...Array(2).fill("detectors"),
    ...Array(2).fill("readers"),
    ...Array(3).fill("boards"),
    ...Array(3).fill("enrichment"),
  ]);
});
