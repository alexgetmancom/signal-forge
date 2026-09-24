import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { recordCredentialRejection } from "../src/credentials.js";
import { keyStandings } from "../src/reports/keys.js";
import { openDatabase } from "../src/storage/database.js";

const fixture = new URL("./fixtures/config.json", import.meta.url).pathname;

test("keys names the setting to write, separates absent from refused, and never reads a value out", () => {
  const db = openDatabase(":memory:");
  const config = { ...loadConfig({ CONFIG_PATH: fixture }), OPENROUTER_API_KEY: "sk-live-secret" };
  recordCredentialRejection(db, {
    capabilityId: "stepfun",
    source: "stepfun",
    statusCode: 401,
    detail: "Source returned HTTP 401",
  });
  const report = keyStandings(db, config, "attention");
  const serialized = JSON.stringify(report);
  expect(serialized).not.toContain("sk-live-secret");
  const missing = report.needAttention.find((standing) => standing.missing.length);
  // The name of the setting is the actionable part; nothing else says which one to write.
  expect(missing?.missing[0]).toMatch(/^[A-Z][A-Z0-9_]+$/);
  expect(report.needAttention.every((standing) => standing.status !== "ready")).toBe(true);
  expect(report.sourcesBlocked).toBeGreaterThan(0);
  // Asking for everything also lists what is fine, which the default answer leaves out.
  expect(keyStandings(db, config, "all").needAttention.length).toBeGreaterThanOrEqual(report.needAttention.length);
});
