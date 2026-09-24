import { z } from "zod";
import type { Collection, RecordData } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { fetchText } from "./http.js";

/**
 * What a prediction market is betting a lab will ship, and when.
 *
 * This is the first source here that observes nobody's product. Every other collector reads a
 * surface a vendor controls: a catalogue answers for its own models, an arena serves what it was
 * given, a changelog is the maker's own word. A market is strangers pricing a rumour, which is why
 * it starts and stays in shadow, and why `confidenceFor` gives the stream `observed`, the floor.
 * It corroborates a sighting; it can never be the evidence a card rests on.
 *
 * It earns its place on names. In the fortnight to 2026-09-20 these markets traded `Claude Fable`,
 * `GPT Luna` and `Meta's Watermelon` -- the first two matching hypotheses this tracker had already
 * formed from arena and catalogue sightings, and the third naming a Meta codename no source here
 * had recorded at all. A market that opens on a codename is a second witness that the codename is
 * real, and one that opens on a codename this feed has never seen is a gap in its coverage.
 */

/** Markets are grouped into events; the AI tag is the only one worth reading and is applied by hand upstream. */
const GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events";
const POLYMARKET_URL = "https://polymarket.com/markets/ai";
/** The tag answers 252 events; the pages are read until one comes back short. */
const PAGE_SIZE = 100;
const MAX_PAGES = 6;

const marketSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1).nullish(),
  slug: z.string().min(1).nullish(),
  closed: z.boolean().nullish(),
  endDate: z.string().nullish(),
  liquidityNum: z.number().nullish(),
  volumeNum: z.number().nullish(),
  outcomePrices: z.string().nullish(),
  description: z.string().nullish(),
  resolutionSource: z.string().nullish(),
});
const eventsSchema = z.array(
  z.object({
    slug: z.string().nullish(),
    description: z.string().nullish(),
    resolutionSource: z.string().nullish(),
    markets: z.array(marketSchema).nullish(),
  }),
);

/**
 * A market that resolves by reading the Arena leaderboard is this tracker's own data with a price
 * on it. 323 of the 2990 open AI markets on 2026-09-20 were "Will X have the best AI model at the
 * end of the month", every one of them settled from the Text Arena table that `arena-leaderboards`
 * already collects. Counting those as a second witness would let the feed corroborate itself.
 */
const RESOLVES_FROM_OUR_OWN_SOURCES = /arena\.ai|lmarena|text arena/i;

/**
 * A question about a model shipping. The AI tag is applied generously upstream -- it carried
 * Ubisoft's acquisition, Waymo's city count and the Chinese Military Companies list -- so the
 * question itself has to say a model is being released before it is read as one.
 */
const ASKS_ABOUT_A_RELEASE = /\breleased? by\b|\bdebut\b|model release|\blaunch(?:es|ed)? a new\b/i;
const ASKS_ABOUT_A_COMPANY =
  /valuation|market cap|\bIPO\b|acquir|Millennium|layoffs?|ticker|copyright|moratorium|military/i;

/**
 * Below this a price is one person's opinion rather than a market's. Measured: of 2990 open AI
 * markets only 135 held $10k of liquidity and 804 held $1k, and the thin ones reversed a ten-point
 * move the same day a quarter of the time.
 */
const LIQUIDITY_FLOOR_USD = 3_000;

/**
 * Prices are stored in five-point buckets, for the reason `benchmarks.ts` stores no rank and
 * `community.ts` stores no Elo: a quoted price moves on every trade, and recording it as read
 * would make each poll an event for every market. Five points is coarser than the noise measured
 * here -- 24% of consecutive ten-point moves reversed within the day -- and finer than the moves
 * that meant something, which ran from twenty to forty-seven points.
 */
const PRICE_BUCKET = 0.05;

export function priceBucket(price: number): number {
  return Math.round(Math.round(price / PRICE_BUCKET) * PRICE_BUCKET * 100) / 100;
}

function firstOutcomePrice(outcomePrices: string | null | undefined): number | null {
  if (!outcomePrices) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcomePrices);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.length) return null;
  const price = Number(parsed[0]);
  return Number.isFinite(price) && price >= 0 && price <= 1 ? price : null;
}

export function parsePolymarket(pages: readonly string[]): Collection {
  const records: RecordData[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    for (const event of eventsSchema.parse(JSON.parse(page))) {
      for (const market of event.markets ?? []) {
        const question = market.question?.trim();
        if (!question || market.closed) continue;
        if (!ASKS_ABOUT_A_RELEASE.test(question) || ASKS_ABOUT_A_COMPANY.test(question)) continue;
        const settledBy = `${market.description ?? ""} ${market.resolutionSource ?? ""} ${event.description ?? ""} ${event.resolutionSource ?? ""}`;
        if (RESOLVES_FROM_OUR_OWN_SOURCES.test(settledBy)) continue;
        const liquidity = market.liquidityNum ?? 0;
        if (liquidity < LIQUIDITY_FLOOR_USD) continue;
        const price = firstOutcomePrice(market.outcomePrices);
        if (price === null) continue;
        if (seen.has(market.id)) continue;
        seen.add(market.id);
        records.push({
          id: market.id,
          name: question,
          // The date the question is asking about, which is the whole content of a release market.
          ...(market.endDate ? { deadline: market.endDate.slice(0, 10) } : {}),
          price: priceBucket(price),
          // Rounded hard for the same reason the price is bucketed: a book that deepens by $40
          // overnight is not news, and a market crossing into or out of being worth reading is.
          liquidityUsd: Math.round(liquidity / 1_000) * 1_000,
          ...(market.slug ? { url: `https://polymarket.com/market/${market.slug}` } : {}),
        });
      }
    }
  }
  if (!records.length) throw new Error("polymarket: the AI tag listed no release markets");
  return {
    source: "polymarket",
    stream: "markets",
    url: POLYMARKET_URL,
    raw: pages,
    trackChanges: true,
    // Asked with `closed=false`: a market leaves this answer by resolving. See Collection.churns.
    churns: true,
    records,
  };
}

export async function collectPolymarket(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  const pages: string[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${GAMMA_EVENTS_URL}?closed=false&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}&tag_slug=ai`;
    const body = await fetchText(url, {}, request, undefined, cache);
    pages.push(body);
    // A short page is the end of the tag. Asking past it answers an empty array and costs a request.
    if (eventsSchema.parse(JSON.parse(body)).length < PAGE_SIZE) break;
  }
  return parsePolymarket(pages);
}
