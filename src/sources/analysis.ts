import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Collection } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import { fetchText } from "./http.js";

/**
 * Artificial Analysis measures models everyone already knows about, days after they ship, so its
 * language ratings can never break news. What they can do is confirm one: an independent quality
 * reading on a model this feed already reported is the second witness that turns a claim into a fact.
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

function parseArtificialAnalysis(payload: string): Collection {
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

/**
 * The media arenas, which render from JavaScript on the site and answer in data through the same
 * keyed API (measured 2026-09-16: 159 image, 83 video, 76 image-editing and 90 speech models). Unlike
 * the language ratings these are blind votes on models that are sometimes not released yet --
 * `gpt-image-2.5-flare-2026-09-08` led the image board the week OpenAI listed it -- so a new entry
 * in the leading places is a sighting rather than a confirmation.
 */
export const MEDIA_ARENAS = ["text-to-image", "image-editing", "text-to-video", "text-to-speech"] as const;
export type MediaArena = (typeof MEDIA_ARENAS)[number];

/** Places that carry a rank; below them a board reshuffles on every vote and nobody reads it. */
const MEDIA_RANKED_PLACES = 3;

const mediaSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        slug: z.string().nullish(),
        model_creator: z.object({ name: z.string().min(1) }).nullish(),
        elo: z.number(),
        rank: z.number().int().positive(),
      }),
    )
    .min(1),
});

export function parseMediaArena(arena: MediaArena, payload: string): Collection {
  const raw: unknown = JSON.parse(payload);
  return {
    source: `artificial-analysis:${arena}`,
    stream: "leaderboards",
    url: `https://artificialanalysis.ai/${arena}/arena`,
    raw,
    trackChanges: true,
    records: mediaSchema.parse(raw).data.map((model) => ({
      id: model.id,
      name: model.name,
      modelKey: model.slug ?? model.id,
      category: `artificial-analysis/${arena}`,
      ...(model.model_creator?.name ? { maker: model.model_creator.name } : {}),
      score: model.elo,
      ...(model.rank <= MEDIA_RANKED_PLACES ? { rank: model.rank } : {}),
    })),
  };
}

export async function collectMediaArena(
  config: AppConfig,
  arena: MediaArena,
  request: Fetch = fetch,
): Promise<Collection> {
  const key = config.ARTIFICIAL_ANALYSIS_API_KEY;
  if (!key) throw new Error("Artificial Analysis needs ARTIFICIAL_ANALYSIS_API_KEY");
  return parseMediaArena(
    arena,
    await fetchText(
      `https://artificialanalysis.ai/api/v2/data/media/${arena}`,
      { "x-api-key": key, accept: "application/json" },
      request,
    ),
  );
}
