import { z } from "zod";
import { attentionScore, huggingFaceAttentionScore } from "../attention.js";
import type { AppConfig } from "../config.js";
import type { Collection, RecordData } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { fetchText } from "./http.js";

export const GITHUB_DISCOVERY_QUERIES = [
  { id: "ai", topic: "topic:artificial-intelligence", minimumStars: 20 },
  { id: "llm", topic: "llm", minimumStars: 15 },
  { id: "agent", topic: "agent", minimumStars: 15 },
  { id: "mcp", topic: "mcp", minimumStars: 10 },
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

const huggingFaceDiscoveryModel = z.object({
  id: z.string().min(1),
  author: z.string().nullish(),
  createdAt: z.string().min(1),
  lastModified: z.string().nullish(),
  downloads: z.number().int().nonnegative().nullish(),
  likes: z.number().int().nonnegative().nullish(),
  pipeline_tag: z.string().nullish(),
  tags: z.array(z.string()).default([]),
  private: z.boolean().default(false),
  gated: z.union([z.boolean(), z.string()]).nullish(),
  // Present once weights are uploaded, which is the moment a release becomes a fact. An empty
  // repository created minutes earlier carries neither.
  safetensors: z.object({ total: z.number().nonnegative().nullish() }).nullish(),
  cardData: z.object({ base_model: z.unknown().nullish() }).nullish(),
});

const huggingFaceDiscoverySchema = z.array(huggingFaceDiscoveryModel).max(1_000);

/**
 * A model repository is created empty and the weights follow hours later -- Atria Dawn Preview was
 * created at 08:27 and carried its weights at 11:44 -- so a single look at creation time sees
 * nothing. The sweep therefore re-reads a window rather than the newest page: everything created in
 * the last three days is re-examined on every poll, which is also why a burst in the feed can no
 * longer outrun the collector.
 */
const HUGGINGFACE_WINDOW_HOURS = 12;

/**
 * The feed cannot be paged deeper than four thousand entries: `skip=3000` answers, `skip=4000` is
 * rejected outright (measured 2026-09-14). At the 201 repositories an hour the feed produced that
 * day four pages reach back about twenty hours, so a twelve-hour window keeps a margin of roughly
 * two thirds for a busier day, and a sweep that runs out of pages before reaching the cutoff says
 * so rather than reporting a window it did not cover.
 */
const HUGGINGFACE_PAGE_LIMIT = 1_000;
const HUGGINGFACE_MAX_PAGES = 4;

const HUGGINGFACE_EXPAND = [
  "createdAt",
  "lastModified",
  "downloads",
  "likes",
  "pipeline_tag",
  "tags",
  "private",
  "gated",
  "author",
  "safetensors",
  "cardData",
];

/**
 * What separates a laboratory's release from the rest of the feed at the moment the weights land,
 * when nobody has reacted to it yet.
 *
 * Measured on 270 models drawn from four days of the feed (2026-09-14): 66 carried a parameter
 * count at all, 39 of those declared no base model, and exactly one of those reached a hundred
 * billion parameters -- a re-upload of somebody else's weights, which gives itself away by carrying
 * a parameter count already seen in the window. Popularity cannot do this work: 12,850 of 13,770
 * captured repositories had zero likes when first seen, and the busiest had six.
 *
 * The floor is deliberately low and the decision is recorded rather than delivered. A week of
 * shadow output is what a real floor gets set from; training checkpoints published without a base
 * model are the false positives to look for.
 */
const NOVEL_PARAMETER_FLOOR = 20_000_000_000;

/**
 * Likes arrive too late to find a release but they do find what the parameter rule cannot see: a
 * gated repository, a format that carries no safetensors index, a small model that matters anyway.
 * Bucketed, because the raw count moves on every poll and a body that moves emits a change event
 * that means nothing.
 */
const LIKES_FLOOR = 20;

/**
 * Only as long as the sweep can still re-read the model. Following a repository for two days after
 * it leaves the window would mean re-reading stored candidates rather than the feed, which is a
 * different collector; twenty likes inside twelve hours is what a launch looks like anyway.
 */
const LIKES_WINDOW_HOURS = HUGGINGFACE_WINDOW_HOURS;

function parameterTotal(model: z.infer<typeof huggingFaceDiscoveryModel>): number | null {
  const total = model.safetensors?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : null;
}

function declaresBaseModel(model: z.infer<typeof huggingFaceDiscoveryModel>): boolean {
  const base = model.cardData?.base_model;
  if (Array.isArray(base)) return base.length > 0;
  return typeof base === "string" ? base.trim().length > 0 : Boolean(base);
}

/**
 * Why this repository is worth a person's attention, or an empty list. Reasons carry no measured
 * number: `records.body` is compared byte for byte, so a reason that embedded the like count would
 * report a change every time somebody clicked.
 */
function notableReasons(
  model: z.infer<typeof huggingFaceDiscoveryModel>,
  originalOf: ReadonlyMap<number, string>,
  now: number,
): string[] {
  const reasons: string[] = [];
  const total = parameterTotal(model);
  if (total !== null && total >= NOVEL_PARAMETER_FLOOR && !declaresBaseModel(model)) {
    // A copy of somebody else's weights reproduces the parameter count exactly; whoever published
    // that count first in the window is the origin and the rest are mirrors.
    if (originalOf.get(total) === model.id) reasons.push("novel-parameter-total");
  }
  const created = Date.parse(model.createdAt);
  const young = Number.isFinite(created) && now - created <= LIKES_WINDOW_HOURS * 3_600_000;
  if (young && (model.likes ?? 0) >= LIKES_FLOOR) reasons.push(`likes-within-${LIKES_WINDOW_HOURS}h`);
  return reasons;
}

/** The earliest-created repository for each parameter count in the sweep. */
function originalsByParameterTotal(models: readonly z.infer<typeof huggingFaceDiscoveryModel>[]): Map<number, string> {
  const earliest = new Map<number, { id: string; created: number }>();
  for (const model of models) {
    const total = parameterTotal(model);
    if (total === null) continue;
    const created = Date.parse(model.createdAt);
    if (!Number.isFinite(created)) continue;
    const held = earliest.get(total);
    if (!held || created < held.created || (created === held.created && model.id < held.id)) {
      earliest.set(total, { id: model.id, created });
    }
  }
  return new Map([...earliest].map(([total, held]) => [total, held.id]));
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

export async function collectHuggingFaceDiscovery(
  config: AppConfig,
  request: Fetch = fetch,
  cache?: HttpCache,
  now = new Date(),
): Promise<Collection> {
  const expand = HUGGINGFACE_EXPAND.map((field) => `expand[]=${field}`).join("&");
  const feed = (skip: number) =>
    `https://huggingface.co/api/models?sort=createdAt&direction=-1&limit=${HUGGINGFACE_PAGE_LIMIT}` +
    `${skip ? `&skip=${skip}` : ""}&${expand}`;
  const headers = {
    accept: "application/json",
    ...(config.HF_TOKEN ? { Authorization: `Bearer ${config.HF_TOKEN}` } : {}),
  };
  const cutoff = now.getTime() - HUGGINGFACE_WINDOW_HOURS * 3_600_000;
  const models: z.infer<typeof huggingFaceDiscoveryModel>[] = [];
  let pages = 0;
  // A sweep that exhausts its pages before reaching the cutoff saw less than the window it claims.
  let covered = false;
  // `skip` walks the feed backwards in whole pages, which needs nothing carried between requests:
  // the alternative is the opaque cursor the API returns in a Link header, and reading that would
  // mean teaching every collector's fetch helper to hand back response headers.
  while (pages < HUGGINGFACE_MAX_PAGES) {
    const page = huggingFaceDiscoverySchema.parse(
      JSON.parse(await fetchText(feed(pages * HUGGINGFACE_PAGE_LIMIT), headers, request, undefined, cache)),
    );
    models.push(...page);
    pages += 1;
    const oldest = page.at(-1)?.createdAt;
    // The feed is ordered newest first, so the last entry of a page decides whether the window is
    // covered. A short page is the end of the feed, not a paging artefact worth another request.
    covered = !oldest || Date.parse(oldest) < cutoff || page.length < HUGGINGFACE_PAGE_LIMIT;
    if (covered) break;
  }
  const within = models.filter((model) => !model.private && Date.parse(model.createdAt) >= cutoff);
  const originals = originalsByParameterTotal(within);
  const records: RecordData[] = within.map((model) => {
    const attention = huggingFaceAttentionScore(
      {
        name: model.id,
        created: model.createdAt,
        downloads: model.downloads ?? null,
        likes: model.likes ?? null,
        pipelineTag: model.pipeline_tag ?? null,
        tags: model.tags,
      },
      now.getTime(),
    );
    const reasons = notableReasons(model, originals, now.getTime());
    return {
      id: model.id,
      name: model.id,
      url: `https://huggingface.co/${model.id}`,
      author: model.author,
      created: model.createdAt,
      pipelineTag: model.pipeline_tag ?? null,
      tags: [...model.tags].sort(),
      // The parameter count is a fact about the weights: it appears once, when they are uploaded,
      // and never moves again. Likes, downloads and the modification time do move, and a body
      // carrying them reports a change on every poll that says nothing about the model.
      parameters: parameterTotal(model),
      derivative: declaresBaseModel(model),
      discoveryStatus: reasons.length ? "notable" : "candidate",
      notableReasons: reasons,
      attentionScore: attention.score,
      attentionReasons: attention.reasons,
    };
  });
  return {
    source: "discovery:huggingface-recent",
    stream: "weights",
    url: feed(0),
    raw: { pages, models: models.length, window: within.length, covered },
    appendOnly: true,
    records,
  };
}
