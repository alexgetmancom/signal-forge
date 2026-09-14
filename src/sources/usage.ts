import { z } from "zod";
import type { Collection } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import { nextData } from "./html.js";
import { fetchText } from "./http.js";

/**
 * Which models people actually run, in tokens.
 *
 * Everything else this service collects says a model exists. Nothing said whether anyone uses it,
 * and without that the only way to decide whether a price move was worth a line was taste. It cost
 * a weekly recap its lead: Qwen3 14B, a small model from April 2025, took the price line because a
 * reseller's cheapest provider changed for six days, while DeepSeek V4 Flash 0731 -- first on this
 * very ranking, fifty trillion tokens in a month -- went unmentioned as it got three times cheaper.
 *
 * The page publishes a daily row per model. Nobody is told about any of this directly: it is a
 * shadow source, collected so that other decisions can be measured rather than argued.
 */
const RANKINGS_URL = "https://openrouter.ai/rankings";
/** A ranking that came back with a handful of rows is a broken read, not a quiet week. */
const MINIMUM_MODELS = 10;

const usageRows = z
  .array(
    z.object({
      model_permaslug: z.string().min(1),
      total_prompt_tokens: z.number().nonnegative(),
      total_completion_tokens: z.number().nonnegative(),
      count: z.number().nonnegative().optional(),
    }),
  )
  .min(1);

type Ranked = { slug: string; tokens: number; requests: number };

/** Every dehydrated query on the page, flattened: the rankings arrive as one of them. */
function usageQueries(html: string): unknown[] {
  const queries = nextData(html, "queries");
  return Array.isArray(queries) ? queries : [];
}

export function parseOpenRouterUsage(html: string): Collection {
  const totals = new Map<string, Ranked>();
  let raw: unknown = null;
  for (const query of usageQueries(html)) {
    const data = (query as { state?: { data?: unknown } })?.state?.data;
    const parsed = usageRows.safeParse(data);
    if (!parsed.success) continue;
    raw = data;
    for (const row of parsed.data) {
      const held = totals.get(row.model_permaslug) ?? { slug: row.model_permaslug, tokens: 0, requests: 0 };
      held.tokens += row.total_prompt_tokens + row.total_completion_tokens;
      held.requests += row.count ?? 0;
      totals.set(row.model_permaslug, held);
    }
  }
  const ranked = [...totals.values()].sort((one, other) => other.tokens - one.tokens);
  if (ranked.length < MINIMUM_MODELS) throw new Error("OpenRouter rankings no longer expose per-model usage");
  return {
    source: "openrouter-usage",
    stream: "leaderboards",
    url: RANKINGS_URL,
    raw,
    // Usage moves every hour and none of those moves is news. Only a model appearing on the
    // ranking for the first time is an event, and even that is told to nobody.
    appendOnly: true,
    records: ranked.map((model, index) => ({
      id: model.slug,
      name: model.slug,
      category: "OpenRouter usage",
      rank: index + 1,
      tokens: model.tokens,
      requests: model.requests,
      url: RANKINGS_URL,
    })),
  };
}

export async function collectOpenRouterUsage(request: Fetch = fetch): Promise<Collection> {
  return parseOpenRouterUsage(await fetchText(RANKINGS_URL, {}, request));
}
