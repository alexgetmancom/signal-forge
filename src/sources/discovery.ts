import { z } from "zod";
import { attentionScore } from "../attention.js";
import type { AppConfig } from "../config.js";
import type { Collection, RecordData } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { fetchText } from "./http.js";

/**
 * What GitHub is building, at a floor where somebody other than the author noticed.
 *
 * These four searches collected 239 repositories in the three days to 2026-09-23 and delivered none
 * of them: nothing here is a card, and their whole job is to say that a model is being built on,
 * which `breakouts.ts` counts. 128 of the 208 distinct repositories sat in the 15-to-19 star band --
 * a week-old project with a first page of stars, of which `zhangcy122/OpenJev` and `andududu/jeview`
 * are typical. Twenty stars is where a repository stops being its author's and becomes the field's,
 * and a model that is actually taking off crosses it in the same days: the threshold a breakout
 * needs is three such repositories, not thirty hobby forks.
 */
export const GITHUB_DISCOVERY_QUERIES = [
  { id: "ai", topic: "topic:artificial-intelligence", minimumStars: 20 },
  { id: "llm", topic: "llm", minimumStars: 20 },
  { id: "agent", topic: "agent", minimumStars: 20 },
  { id: "mcp", topic: "mcp", minimumStars: 20 },
] as const;

type GithubDiscoveryQuery = (typeof GITHUB_DISCOVERY_QUERIES)[number];

const repositorySchema = z.object({
  full_name: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  name: z.string().min(1),
  html_url: z.url(),
  owner: z.object({ login: z.string().min(1) }),
  description: z.string().nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  stargazers_count: z.number().int().nonnegative(),
  forks_count: z.number().int().nonnegative(),
  language: z.string().nullable(),
  topics: z.array(z.string()).default([]),
  fork: z.boolean(),
  archived: z.boolean(),
});

const githubSearchSchema = z.object({
  total_count: z.number().int().nonnegative(),
  incomplete_results: z.boolean(),
  items: z.array(repositorySchema).max(100),
});

const trendingModel = z.object({
  id: z.string().min(1),
  author: z.string().nullish(),
  createdAt: z.string().min(1),
  likes: z.number().int().nonnegative().nullish(),
  pipeline_tag: z.string().nullish(),
  tags: z.array(z.string()).default([]),
  private: z.boolean().default(false),
  safetensors: z.object({ total: z.number().nonnegative().nullish() }).nullish(),
  cardData: z.object({ base_model: z.unknown().nullish() }).nullish(),
  gated: z.union([z.boolean(), z.string()]).nullish(),
  config: z.object({ architectures: z.array(z.string()).nullish() }).nullish(),
});

const trendingSchema = z.array(trendingModel).max(1_000);

/**
 * What the registry itself says is taking off, instead of everything uploaded.
 *
 * The creation-ordered feed this replaced read about three thousand repositories a day. Measured on
 * production over the week to 2026-09-16: 21,562 events, not one delivered, 69,526 Model Facts rows
 * derived from quantisations and fine-tunes, and a story per upload. Popularity cannot find a
 * release the hour its weights land -- the maker's own account does that, and those accounts are
 * collected as sources of their own -- but it is the only way to hear about a model from a lab this
 * deployment does not follow. The trending order is Hugging Face's own measure of recent likes, so
 * the like velocity a threshold would try to approximate is already computed.
 *
 * Entering this list is the event. A model that stays on it says nothing new, and one that leaves
 * has not gone anywhere, so nothing is reported on either.
 */
const TRENDING_LIMIT = 100;

/**
 * A model trending for the first time a fortnight after upload is being rediscovered, not released.
 * `sentence-transformers/all-MiniLM-L6-v2` (1,658 days old) and `openai-community/gpt2` sat in the
 * top twenty on 2026-09-16.
 */
const TRENDING_MAX_AGE_DAYS = 14;

/**
 * Somebody else's model, republished. Most of the list is one of these: on 2026-09-16, 58 of the
 * top 100 declared a base model, and the rest of the copies say so in their name instead --
 * `Qwen3.8-27B-Uncensored-GGUF`, `GLM-5.3-CYBERSECURITY-FP8`, `penclaw-GLM-5.3-abliterated`.
 */
const REPUBLISHED =
  /(^|[-_.])(gguf|gptq|awq|exl[23]|mlx|nvfp4|fp8|fp4|int[48]|w[48]a\d+|bnb|\d-?bit|lora|adapter|merged?|abliterated|uncensored|heretic|obliterated|distill(ed)?)($|[-_.])/i;

function parameterTotal(model: z.infer<typeof trendingModel>): number | null {
  const total = model.safetensors?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : null;
}

function isRepublished(model: z.infer<typeof trendingModel>): boolean {
  const base = model.cardData?.base_model;
  const declared = Array.isArray(base)
    ? base.length > 0
    : typeof base === "string"
      ? base.trim() !== ""
      : Boolean(base);
  return (
    declared ||
    model.tags.some((tag) => tag.startsWith("base_model:")) ||
    REPUBLISHED.test(model.id.slice(model.id.indexOf("/") + 1))
  );
}

function sevenDayDate(now: Date): string {
  return new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString().slice(0, 10);
}

function githubQuery(query: GithubDiscoveryQuery, now: Date): string {
  return `${query.topic} created:>${sevenDayDate(now)} stars:>${query.minimumStars} fork:false archived:false`;
}

export async function collectGithubDiscovery(
  config: AppConfig,
  query: GithubDiscoveryQuery,
  request: Fetch = fetch,
  now = new Date(),
  cache?: HttpCache,
): Promise<Collection> {
  if (!config.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required for GitHub discovery");
  const q = githubQuery(query, now);
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=100`;
  const body: unknown = JSON.parse(
    await fetchText(
      url,
      { Accept: "application/vnd.github+json", Authorization: `Bearer ${config.GITHUB_TOKEN}` },
      request,
      undefined,
      cache,
    ),
  );
  const data = githubSearchSchema.parse(body);
  // GitHub stops a search that runs out of time and says so; a partial page is not the ranking.
  if (data.incomplete_results) throw new Error("GitHub search returned incomplete results");
  const records: RecordData[] = data.items
    .filter((repository) => !repository.fork && !repository.archived)
    .map((repository) => {
      const attention = attentionScore(
        {
          name: repository.full_name,
          description: repository.description,
          topics: repository.topics,
          created: repository.created_at,
          stars: repository.stargazers_count,
          forks: repository.forks_count,
        },
        now.getTime(),
      );
      return {
        id: repository.full_name,
        name: repository.full_name,
        url: repository.html_url,
        owner: repository.owner.login,
        description: repository.description,
        created: repository.created_at,
        updated: repository.updated_at,
        stars: repository.stargazers_count,
        forks: repository.forks_count,
        language: repository.language,
        topics: [...repository.topics].sort(),
        query: q,
        discoveryStatus: "candidate",
        attentionScore: attention.score,
        attentionReasons: attention.reasons,
      };
    });
  return {
    source: `discovery:github-${query.id}`,
    stream: "github",
    url,
    raw: data,
    appendOnly: true,
    records,
  };
}

export async function collectHuggingFaceTrending(
  config: AppConfig,
  request: Fetch = fetch,
  cache?: HttpCache,
  now = new Date(),
): Promise<Collection> {
  const expand = [
    "createdAt",
    "likes",
    "pipeline_tag",
    "tags",
    "private",
    "author",
    "safetensors",
    "cardData",
    "gated",
    "config",
  ]
    .map((field) => `expand[]=${field}`)
    .join("&");
  const url = `https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=${TRENDING_LIMIT}&${expand}`;
  const headers = {
    accept: "application/json",
    ...(config.HF_TOKEN ? { Authorization: `Bearer ${config.HF_TOKEN}` } : {}),
  };
  const models = trendingSchema.parse(JSON.parse(await fetchText(url, headers, request, undefined, cache)));
  const cutoff = now.getTime() - TRENDING_MAX_AGE_DAYS * 24 * 3_600_000;
  const releases = models.filter(
    (model) => !model.private && Date.parse(model.createdAt) >= cutoff && !isRepublished(model),
  );
  const records: RecordData[] = releases.map((model) => ({
    id: model.id,
    name: model.id,
    url: `https://huggingface.co/${model.id}`,
    author: model.author ?? model.id.split("/")[0],
    created: model.createdAt,
    pipelineTag: model.pipeline_tag ?? null,
    // Open weights are not open source until a licence says so, and the card should say which.
    license: model.tags.find((tag) => tag.startsWith("license:"))?.slice("license:".length) ?? null,
    parameters: parameterTotal(model),
    // What a reader decides "can I run this" from without opening the page: the architecture names the
    // runtime it needs, and a gated repository needs an approval before the weights download.
    architecture: model.config?.architectures?.[0] ?? null,
    access: model.gated ? "gated" : "open",
    // The count when the model entered the list. Changes to a trending record are never reported, so
    // a number that moves on every poll costs nothing here and tells the reader why it was picked.
    likes: model.likes ?? null,
  }));
  return {
    source: "discovery:huggingface-trending",
    stream: "weights",
    url,
    raw: { trending: models.length, releases: releases.length },
    appendOnly: true,
    records,
  };
}
