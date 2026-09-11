import { z } from "zod";
import type { Collection } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { fetchText } from "./http.js";

/**
 * Weights and packages usually appear before the announcement: a repository is created while the
 * launch post is still a draft, and a CLI ships a version that names a model nobody has confirmed.
 * These collectors watch those two places.
 */

const hfModels = z
  .array(
    z.object({
      id: z.string().min(1),
      author: z.string().nullish(),
      createdAt: z.string().min(1),
      pipeline_tag: z.string().nullish(),
      library_name: z.string().nullish(),
      tags: z.array(z.string()).default([]),
      lastModified: z.string().nullish(),
      likes: z.number().int().nonnegative().nullish(),
      downloads: z.number().int().nonnegative().nullish(),
      private: z.boolean().default(false),
      gated: z.union([z.boolean(), z.string()]).nullish(),
    }),
  )
  .min(1);

/**
 * The organisations worth watching; a global feed of every new repository is not a signal.
 *
 * NVIDIA is deliberately absent. It published six of the eight events these twelve organisations
 * produced in four days, and all of them were research checkpoints or quantised copies of other
 * labs' models — a reader looking for what is new learns nothing from a second copy of GLM-5.3 in
 * a different number format.
 */
export const HF_AUTHORS = [
  "openai",
  "google",
  "meta-llama",
  "deepseek-ai",
  "Qwen",
  "moonshotai",
  "mistralai",
  "MiniMaxAI",
  "zai-org",
  "microsoft",
  "xai-org",
];

export function parseHuggingFace(payload: string, author: string): Collection {
  const models = hfModels.parse(JSON.parse(payload));
  if (models.every((model) => model.private))
    throw new Error(`Hugging Face catalogue for ${author} has no public models`);
  return {
    source: `huggingface:${author}`,
    stream: "weights",
    url: `https://huggingface.co/${author}`,
    raw: payload,
    // Repositories are only ever added here; a listing that omits one is a paging artefact, not a
    // deletion, and treating it as a removal would invent news.
    appendOnly: true,
    records: models.map((model) => ({
      id: model.id,
      name: model.id,
      url: `https://huggingface.co/${model.id}`,
      maker: model.author ?? author,
      category: model.pipeline_tag ?? null,
      library: model.library_name ?? null,
      access: model.gated ? "gated" : "public",
      created: model.createdAt,
      modified: model.lastModified ?? null,
      likes: model.likes ?? null,
      downloads: model.downloads ?? null,
      tags: [...model.tags].sort(),
      pipeline: model.pipeline_tag ?? null,
    })),
  };
}

export async function collectHuggingFace(
  author: string,
  token?: string,
  request: Fetch = fetch,
  cache?: HttpCache,
): Promise<Collection> {
  const url = `https://huggingface.co/api/models?author=${encodeURIComponent(author)}&sort=createdAt&direction=-1&limit=50`;
  const headers = { accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  return parseHuggingFace(await fetchText(url, headers, request, undefined, cache), author);
}

const npmPackage = z.object({
  name: z.string().min(1),
  "dist-tags": z.record(z.string(), z.string()),
  time: z.record(z.string(), z.string()),
});

/** Packages whose releases lead the announcements. */
export const NPM_PACKAGES = [
  "@openai/codex",
  "@anthropic-ai/claude-code",
  "@google/gemini-cli",
  "@qwen-code/qwen-code",
  "@deepseek-ai/dsh",
];
export const PYPI_PACKAGES = ["openai", "anthropic", "mistralai"];

/**
 * `@openai/codex` publishes the same version under a tag per operating system and architecture:
 * one alpha bump appears as seven identical events. The platform tags are dropped, leaving the
 * channels a person actually installs.
 */
const PLATFORM_TAG = /(^|-)(win32|darwin|linux|freebsd|android|x64|arm64|arm|ia32|musl|glibc)(-|$)/;

export function parseNpm(payload: string): Collection {
  const data = npmPackage.parse(JSON.parse(payload));
  const tags = Object.fromEntries(Object.entries(data["dist-tags"]).filter(([tag]) => !PLATFORM_TAG.test(tag)));
  return {
    source: `npm:${data.name}`,
    stream: "packages",
    url: `https://www.npmjs.com/package/${data.name}`,
    raw: payload,
    // One record per channel rather than per version: "latest moved" is the event, and a record
    // per published version would emit one message for every nightly.
    records: Object.entries(tags).map(([tag, version]) => ({
      id: tag,
      name: `${data.name}@${tag}`,
      url: `https://www.npmjs.com/package/${data.name}/v/${version}`,
      version,
      published: data.time[version] ?? null,
    })),
  };
}

export async function collectNpm(name: string, request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  const url = `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
  const collection = parseNpm(await fetchText(url, { accept: "application/json" }, request, undefined, cache));
  if (collection.source !== `npm:${name}`)
    throw new Error(`npm returned package ${collection.source.slice("npm:".length)}, expected ${name}`);
  return collection;
}

const pypiPackage = z.object({
  info: z.object({ name: z.string().min(1), version: z.string().min(1) }),
  releases: z.record(z.string(), z.array(z.object({ upload_time_iso_8601: z.string().optional() }))).optional(),
});

export function parsePypi(payload: string): Collection {
  const data = pypiPackage.parse(JSON.parse(payload));
  const uploaded = data.releases?.[data.info.version]?.[0]?.upload_time_iso_8601 ?? null;
  return {
    source: `pypi:${data.info.name}`,
    stream: "packages",
    url: `https://pypi.org/project/${data.info.name}/`,
    raw: payload,
    records: [
      {
        id: "latest",
        name: `${data.info.name} ${data.info.version}`,
        url: `https://pypi.org/project/${data.info.name}/${data.info.version}/`,
        version: data.info.version,
        published: uploaded,
      },
    ],
  };
}

export async function collectPypi(name: string, request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  const collection = parsePypi(
    await fetchText(`https://pypi.org/pypi/${name}/json`, { accept: "application/json" }, request, undefined, cache),
  );
  if (collection.source.toLowerCase() !== `pypi:${name}`.toLowerCase())
    throw new Error(`PyPI returned package ${collection.source.slice("pypi:".length)}, expected ${name}`);
  return collection;
}

const gatewayModels = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().nullish(),
        owned_by: z.string().nullish(),
        description: z.string().nullish(),
        context_window: z.number().nullish(),
        max_tokens: z.number().nullish(),
        pricing: z.record(z.string(), z.unknown()).nullish(),
      }),
    )
    .min(1),
});

export function parseVercelGateway(payload: string): Collection {
  const data = gatewayModels.parse(JSON.parse(payload));
  return {
    source: "vercel-gateway",
    stream: "api-models",
    url: "https://vercel.com/ai-gateway",
    raw: payload,
    records: data.data.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      maker: model.owned_by ?? null,
      context: model.context_window ?? null,
      output: model.max_tokens ?? null,
      pricing: model.pricing ?? null,
    })),
  };
}

export async function collectVercelGateway(request: Fetch = fetch): Promise<Collection> {
  const payload = await fetchText("https://ai-gateway.vercel.sh/v1/models", { accept: "application/json" }, request);
  return parseVercelGateway(payload);
}
