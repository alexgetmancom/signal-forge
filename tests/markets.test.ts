import { expect, test } from "bun:test";
import { confidenceFor, evidenceTypeFor } from "../src/events/confidence.js";
import { signalClass } from "../src/events/signals.js";
import type { Event } from "../src/events/types.js";
import { parsePolymarket, priceBucket } from "../src/sources/markets.js";

const market = (fields: Record<string, unknown>) => ({
  id: "1",
  question: "Claude 6 released by December 31, 2027?",
  slug: "claude-6-released",
  closed: false,
  endDate: "2027-12-31T00:00:00Z",
  liquidityNum: 13_940,
  volumeNum: 8_915,
  outcomePrices: '["0.865", "0.135"]',
  description: "Resolves yes if Anthropic releases a model named Claude 6.",
  ...fields,
});

const page = (markets: readonly Record<string, unknown>[]) => JSON.stringify([{ slug: "ai", markets }]);

test("a release market is kept with its deadline and a bucketed price", () => {
  const collection = parsePolymarket([page([market({})])]);
  expect(collection.source).toBe("polymarket");
  expect(collection.stream).toBe("markets");
  expect(collection.records).toEqual([
    {
      id: "1",
      name: "Claude 6 released by December 31, 2027?",
      deadline: "2027-12-31",
      price: 0.85,
      liquidityUsd: 14_000,
      url: "https://polymarket.com/market/claude-6-released",
    },
  ]);
});

/**
 * The reason this source can be read as a second witness at all. 323 of the 2990 open AI markets on
 * 2026-09-20 settled from the Arena table `arena-leaderboards` already collects, and counting one
 * would let the feed corroborate itself with its own data.
 */
test("a market that settles from a board this tracker collects is not a witness to it", () => {
  const ours = market({
    id: "2",
    question: "Will the next Claude Opus model be released by September 30, 2026?",
    description: "Resolved by the highest rank on the arena.ai Text Arena (Overall) leaderboard.",
  });
  expect(() => parsePolymarket([page([ours])])).toThrow(/no release markets/);
});

test("the AI tag's company questions and thin books are left where they are", () => {
  const rejected = [
    market({ id: "3", question: "Will Anthropic's valuation hit (HIGH) $3.0T by December 31?" }),
    market({ id: "4", question: "Will Ubisoft be acquired before 2027?" }),
    market({ id: "5", question: "Kimi K4 released by October 31, 2026?", liquidityNum: 900 }),
    market({ id: "6", question: "Claude 6 released by June 30, 2027?", closed: true }),
    market({ id: "7", question: "GPT-7 released by December 31, 2027?", outcomePrices: "[]" }),
  ];
  expect(() => parsePolymarket([page(rejected)])).toThrow(/no release markets/);
});

test("pages are joined and a market listed twice is stored once", () => {
  const collection = parsePolymarket([page([market({})]), page([market({})])]);
  expect(collection.records).toHaveLength(1);
});

/**
 * A quoted price moves on every trade. Read as it comes, each poll would be an event for every
 * market; the bucket is what makes a stored price mean "the market changed its mind".
 */
test("a price is stored in buckets coarser than the day's noise", () => {
  expect(priceBucket(0.865)).toBe(0.85);
  expect(priceBucket(0.87)).toBe(0.85);
  expect(priceBucket(0.89)).toBe(0.9);
  const drifted = parsePolymarket([page([market({ outcomePrices: '["0.842", "0.158"]' })])]);
  const quoted = parsePolymarket([page([market({ outcomePrices: '["0.858", "0.142"]' })])]);
  expect(drifted.records[0]?.price).toBe(quoted.records[0]?.price);
});

test("a bet is the weakest evidence in the system and never a card", () => {
  expect(confidenceFor("polymarket", "markets", "third_party")).toBe("observed");
  expect(evidenceTypeFor("polymarket", "markets", "third_party")).toBe("unknown");
  const opened = {
    id: 1,
    source: "polymarket",
    stream: "markets",
    entity_id: "1",
    kind: "new",
    detected_at: "2026-09-20T22:00:00.000Z",
    before_json: null,
    after_json: JSON.stringify({ id: "1", name: "Meta's Watermelon released by November 30, 2026?", price: 0.85 }),
  } as Event;
  expect(signalClass(opened)).toBe("evidence");
  expect(signalClass({ ...opened, kind: "changed", before_json: opened.after_json })).toBe("evidence");
});
