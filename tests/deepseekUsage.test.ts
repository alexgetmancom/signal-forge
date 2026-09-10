import { expect, test } from "bun:test";
import {
  calculateDeepSeekCost,
  claimDeepSeekUsage,
  deepSeekUsage,
  finishDeepSeekUsage,
} from "../src/runtime/deepseekUsage.js";
import { openDatabase } from "../src/storage/database.js";

const usage = {
  promptTokens: 100,
  completionTokens: 10,
  totalTokens: 110,
  promptCacheHitTokens: 20,
  promptCacheMissTokens: 80,
};

test("DeepSeek cost uses UTC peak and off-peak rates", () => {
  expect(calculateDeepSeekCost(usage, "2026-09-09T12:00:00.000Z")).toEqual({
    costUsd: 0.00001806,
    costBasis: "exact",
    pricingPeriod: "off_peak",
  });
  expect(calculateDeepSeekCost(usage, "2026-09-09T02:00:00.000Z")).toEqual({
    costUsd: 0.00003612,
    costBasis: "exact",
    pricingPeriod: "peak",
  });
});

test("usage report keeps token cost, outcomes and code path visible", () => {
  const db = openDatabase(":memory:");
  const attemptedAt = new Date("2026-09-09T12:00:00.000Z");
  db.query("INSERT INTO snapshots(id,source,collected_at,raw_json) VALUES(1,'openrouter',?, '{}')").run(
    attemptedAt.toISOString(),
  );
  db.query(
    "INSERT INTO events(id,source,stream,entity_id,kind,after_json,detected_at,snapshot_id) VALUES(1,'openrouter','api-models','m','changed','{}',?,1)",
  ).run(attemptedAt.toISOString());
  const id = claimDeepSeekUsage(db, {
    eventId: 1,
    source: "openrouter",
    stream: "api-models",
    inputChars: 500,
    attemptedAt,
  });
  expect(id).not.toBeNull();
  finishDeepSeekUsage(db, id as number, {
    outcome: "summarized",
    responseStatus: 200,
    usage,
    errorType: null,
  });
  const report = deepSeekUsage(db, 7, Date.parse("2026-09-10T00:00:00.000Z"));
  expect(report.totals).toMatchObject({
    attempts: 1,
    events: 1,
    outcomes: { summarized: 1 },
    tokens: { prompt: 100, completion: 10, total: 110, cacheHit: 20, cacheMiss: 80 },
    cost: { totalUsd: 0.00001806, totalCents: 0.001806, pricedAttempts: 1, unpricedAttempts: 0, coverage: 1 },
  });
  expect(report.bySource[0]).toMatchObject({ source: "openrouter", stream: "api-models" });
  expect(report.byOperation[0]?.operation).toBe("summary.fillSummaries");
  expect(report.codePaths[0]).toMatchObject({ path: "src/summary.ts", function: "fillSummaries" });
  expect(JSON.stringify(report)).not.toContain("Bearer");
  db.close();
});
