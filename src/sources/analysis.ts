import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Collection } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import { fetchText } from "./http.js";

/**
 * Artificial Analysis measures models everyone already knows about, days after they ship, so it
 * can never break news. What it can do is confirm one: an independent quality and speed reading
 * on a model this feed already reported is the second witness that turns a claim into a fact.
 *
 * Their edge refuses this host's TLS handshake outright, so the source is expected to sit idle
 * until the operator arranges a route. It collects nothing and reports its own silence rather
 * than pretending an unreachable benchmark is an empty one.
 */
const schema = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        slug: z.string().nullish(),
        model_creator: z.object({ name: z.string().min(1) }).nullish(),
        evaluations: z.record(z.string(), z.unknown()).nullish(),
        median_output_tokens_per_second: z.number().nullish(),
        median_time_to_first_token_seconds: z.number().nullish(),
      }),
    )
    .min(1),
});

export function parseArtificialAnalysis(payload: string): Collection {
  const raw: unknown = JSON.parse(payload);
  const data = schema.parse(raw);
  return {
    source: "artificial-analysis",
    stream: "leaderboards",
    url: "https://artificialanalysis.ai/models",
    raw,
    trackChanges: true,
    records: data.data.map((model) => ({
      id: model.id,
      name: model.name,
      modelKey: model.slug ?? model.id,
      category: "artificial-analysis/quality",
      ...(model.model_creator?.name ? { maker: model.model_creator.name } : {}),
      // Latency and throughput move with load on every reading and would make each poll an event.
      ...(model.evaluations ? { score: model.evaluations } : {}),
    })),
  };
}

export async function collectArtificialAnalysis(config: AppConfig, request: Fetch = fetch): Promise<Collection> {
  const key = config.ARTIFICIAL_ANALYSIS_API_KEY;
  if (!key) throw new Error("Artificial Analysis needs ARTIFICIAL_ANALYSIS_API_KEY");
  return parseArtificialAnalysis(
    await fetchText(
      "https://artificialanalysis.ai/api/v2/data/llms/models",
      { "x-api-key": key, accept: "application/json" },
      request,
    ),
  );
}
