import { expect, test } from "bun:test";
import { comparisonBody, hasMoved, leaderboardChange } from "../src/events/changeDetection.js";
import type { Collection } from "../src/events/types.js";

const board = (record: Record<string, unknown>) => JSON.stringify({ category: "text", ...record });

test("a board position below the top ten is not a change, and one crossing the line is", () => {
  // One model passing another moves every row under it; that is one fact, not a change per row.
  expect(leaderboardChange(board({ rank: 15, score: 1000 }), board({ rank: 17, score: 1000 }))).toBe(false);
  expect(leaderboardChange(board({ rank: 4, score: 1000 }), board({ rank: 5, score: 1000 }))).toBe(true);
  // Leaving the ten is the move something downstream speaks about.
  expect(leaderboardChange(board({ rank: 9, score: 1000 }), board({ rank: 11, score: 1000 }))).toBe(true);
});

test("a score that stays inside its own width has not moved, and one that leaves it has", () => {
  // No published interval: a quarter of a per cent either side of the score stands in for one.
  expect(leaderboardChange(board({ score: 1200 }), board({ score: 1202 }))).toBe(false);
  expect(leaderboardChange(board({ score: 1200 }), board({ score: 1210 }))).toBe(true);
  // A published interval is believed over the implied one.
  const interval = (score: number, lower: number, upper: number) =>
    board({ score, scoreLower: lower, scoreUpper: upper });
  expect(leaderboardChange(interval(1200, 1190, 1210), interval(1220, 1205, 1235))).toBe(false);
  expect(leaderboardChange(interval(1200, 1190, 1210), interval(1260, 1250, 1270))).toBe(true);
});

test("metrics drift like the rating does, and a metric that is not a number is compared whole", () => {
  const withMetrics = (metrics: Record<string, unknown>) => board({ score: 1200, metrics });
  expect(leaderboardChange(withMetrics({ latency: 1000 }), withMetrics({ latency: 1002 }))).toBe(false);
  expect(leaderboardChange(withMetrics({ latency: 1000 }), withMetrics({ latency: 1100 }))).toBe(true);
  expect(leaderboardChange(withMetrics({ tier: "a" }), withMetrics({ tier: "b" }))).toBe(true);
  expect(leaderboardChange(withMetrics({ tier: "a" }), withMetrics({ tier: "a", extra: 1 }))).toBe(true);
});

test("votes and sampling times never make a change, and anything beside the numbers does", () => {
  expect(leaderboardChange(board({ score: 1200, votes: 10 }), board({ score: 1200, votes: 90 }))).toBe(false);
  expect(
    leaderboardChange(board({ score: 1200, sampledAt: "2026-01-01" }), board({ score: 1200, sampledAt: "2026-02-01" })),
  ).toBe(false);
  expect(leaderboardChange(board({ score: 1200, name: "A" }), board({ score: 1200, name: "B" }))).toBe(true);
  // Text that cannot be read as a record differs because it differs.
  expect(leaderboardChange("not json", "also not json")).toBe(true);
  expect(leaderboardChange("same", "same")).toBe(false);
});

test("a field that moves on every poll is left out of the comparison, and the key order never matters", () => {
  const body = (record: Record<string, unknown>) => JSON.stringify(record);
  expect(comparisonBody("markets", body({ b: 1, liquidityUsd: 5 }))).toBe(
    comparisonBody("markets", body({ liquidityUsd: 9, b: 1 })),
  );
  expect(comparisonBody("markets", body({ b: 1 }))).not.toBe(comparisonBody("markets", body({ b: 2 })));
  expect(comparisonBody("api-models", body({ id: "m", providers: ["a"], providerCount: 1, created: 1 }))).toBe(
    comparisonBody("api-models", body({ id: "m", providers: ["a", "b"], providerCount: 2, created: 2 })),
  );
  // The judge's verdict is this service catching up with itself, on every stream.
  expect(comparisonBody("news", body({ id: "n", audience: "x" }))).toBe(comparisonBody("news", body({ id: "n" })));
  // The same field on a stream that does not call it restless is a change.
  expect(comparisonBody("news", body({ liquidityUsd: 1 }))).not.toBe(comparisonBody("news", body({ liquidityUsd: 2 })));
  expect(comparisonBody("news", "plain text")).toBe("plain text");
});

test("an append-only collection moves only when it asked to track changes", () => {
  const collection = (extra: Partial<Collection>) =>
    ({ source: "s", stream: "news", url: "u", raw: [], records: [], ...extra }) as Collection;
  expect(hasMoved(collection({}), '{"a":1}', '{"a":1}')).toBe(false);
  expect(hasMoved(collection({}), '{"a":1}', '{"a":2}')).toBe(true);
  expect(hasMoved(collection({ appendOnly: true }), '{"a":1}', '{"a":2}')).toBe(false);
  expect(hasMoved(collection({ appendOnly: true, trackChanges: true }), '{"a":1}', '{"a":2}')).toBe(true);
  expect(hasMoved(collection({ stream: "leaderboards" }), board({ score: 1200 }), board({ score: 1201 }))).toBe(false);
});
