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

/**
 * The Intelligence Index is the number people quote from this site, and the API gives the index
 * without the place, so the place is counted here. Only the leading places carry one: a model
 * arriving near the top moves every row below it, and a rank on six hundred rows would turn each
 * arrival into six hundred events nobody reads. Twenty is enough to see a model climb into the ten
 * a debut is told for.
 */
const INDEX_RANKED_PLACES = 20;
function intelligenceIndex(evaluations: Record<string, unknown> | null | undefined): number | null {
  const value = evaluations?.artificial_analysis_intelligence_index;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseArtificialAnalysis(payload: string): Collection {
  const raw: unknown = JSON.parse(payload);
  const data = schema.parse(raw);
  const places = new Map(
    data.data
      .flatMap((model) => {
        const index = intelligenceIndex(model.evaluations);
        return index === null ? [] : [{ id: model.id, index }];
      })
      .sort((one, other) => other.index - one.index || one.id.localeCompare(other.id))
      .slice(0, INDEX_RANKED_PLACES)
      .map((model, place) => [model.id, place + 1] as const),
  );
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
      ...(places.has(model.id) ? { rank: places.get(model.id) } : {}),
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
