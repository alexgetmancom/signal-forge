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
});

const huggingFaceDiscoverySchema = z.array(huggingFaceDiscoveryModel).max(100);

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
  const url = "https://huggingface.co/api/models?sort=createdAt&direction=-1&limit=100";
  const headers = {
    accept: "application/json",
    ...(config.HF_TOKEN ? { Authorization: `Bearer ${config.HF_TOKEN}` } : {}),
  };
  const body: unknown = JSON.parse(await fetchText(url, headers, request, undefined, cache));
  const models = huggingFaceDiscoverySchema.parse(body);
  const records: RecordData[] = models
    .filter((model) => !model.private)
    .map((model) => {
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
      return {
        id: model.id,
        name: model.id,
        url: `https://huggingface.co/${model.id}`,
        author: model.author,
        created: model.createdAt,
        updated: model.lastModified,
        downloads: model.downloads,
        likes: model.likes,
        pipelineTag: model.pipeline_tag,
        tags: [...model.tags].sort(),
        discoveryStatus: "candidate",
        attentionScore: attention.score,
        attentionReasons: attention.reasons,
      };
    });
  return {
    source: "discovery:huggingface-recent",
    stream: "weights",
    url,
    raw: models,
    appendOnly: true,
    records,
  };
}
