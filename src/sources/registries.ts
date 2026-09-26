import { z } from "zod";
import type { Collection } from "../events/types.js";
import { SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { fetchText } from "./http.js";
import { jsonMembers } from "./jsonMembers.js";

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
  // Meta publishes its newer models under a second organisation; meta-llama carries only Llama.
  "meta-models",
  "ibm-granite",
  "tencent",
  // Shanghai AI Lab publishes under the InternLM organisation on both registries, whatever the
  // model is branded; Atria Dawn Preview landed here three days before its announcement.
  "internlm",
  // PrismML publishes its compressed models only here and in a press release; Ternary Bonsai 2 27B
  // landed on 2026-09-17 with no feed of its own to read.
  "prism-ml",
  // Abacus.AI's Smaug models (Agentic, Flash, Mini) reached the Hub weeks before any listing.
  "abacusai",
  // MiMo V2.6's weights reached the Hub on 2026-09-21 and were seen only once they trended.
  "XiaomiMiMo",
  "stepfun-ai",
];

/**
 * The labs whose weights are news the minute they land. One request lists an organisation's fifty
 * newest repositories, and the token allows a thousand every five minutes.
 */
export const HF_LABS = new Set([
  "openai",
  "google",
  "meta-llama",
  "meta-models",
  "deepseek-ai",
  "Qwen",
  "moonshotai",
  "mistralai",
  "MiniMaxAI",
  "zai-org",
  "xai-org",
  "XiaomiMiMo",
  "stepfun-ai",
]);

export function parseHuggingFace(payload: string, author: string): Collection {
  const models = hfModels.parse(JSON.parse(payload)).filter((model) => !model.private);
  if (!models.length) throw new Error(`Hugging Face catalogue for ${author} has no public models`);
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

const routerSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1),
        created: z.number().optional(),
        owned_by: z.string().optional(),
        providers: z
          .array(z.object({ provider: z.string().min(1), status: z.string(), context_length: z.number().optional() }))
          .default([]),
      }),
    )
    .min(1),
});

/**
 * The models Hugging Face's inference router can send a request to, and who serves each: weights on
 * the Hub become callable here, usually at a host other than the lab. Latency, throughput and price
 * are left out, because they move on every read and none of them is a model arriving. Anonymous and
 * validated by ETag, measured 2026-09-17 with 142 models.
 */
export async function collectHuggingFaceRouter(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  const raw: unknown = JSON.parse(
    await fetchText(
      "https://router.huggingface.co/v1/models",
      { accept: "application/json" },
      request,
      undefined,
      cache,
    ),
  );
  const records = routerSchema.parse(raw).data.map((model) => {
    const live = model.providers.filter((provider) => provider.status === "live");
    const context = Math.max(0, ...live.map((provider) => provider.context_length ?? 0));
    return {
      id: model.id,
      name: model.id,
      maker: "Hugging Face",
      url: `https://huggingface.co/${model.id}`,
      ...(model.owned_by ? { owner: model.owned_by } : {}),
      ...(model.created ? { created: new Date(model.created * 1000).toISOString() } : {}),
      ...(context ? { context } : {}),
      providers: live.map((provider) => provider.provider).sort(),
    };
  });
  return {
    source: "huggingface-router",
    stream: "api-models",
    url: "https://huggingface.co/inference/models",
    // A model drops out while no host is up and comes back: GLM-5.1-FP8 and Command A Vision each
    // "left" and "arrived" in September 2026, and neither was news.
    appendOnly: true,
    raw: records,
    records,
  };
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

/** npm stamps every version it publishes; a tagged version without a stamp is a malformed document. */
function publishedAt(time: Record<string, string>, name: string, version: string): string {
  const published = time[version];
  if (!published) throw new Error(`npm package ${name} has no publication time for ${version}`);
  return published;
}

/** One record per channel rather than per version: "latest moved" is the event, and a record per
 * published version would emit one message for every nightly. */
function npmCollection(
  name: string,
  tags: Record<string, string>,
  published: (version: string) => string,
  raw: string,
): Collection {
  return {
    source: `npm:${name}`,
    stream: "packages",
    url: `https://www.npmjs.com/package/${name}`,
    raw,
    records: Object.entries(tags)
      .filter(([tag]) => !PLATFORM_TAG.test(tag))
      .map(([tag, version]) => ({
        id: tag,
        name: `${name}@${tag}`,
        url: `https://www.npmjs.com/package/${name}/v/${version}`,
        version,
        published: published(version),
      })),
  };
}

/**
 * The three members of npm's package document this service reads, and the document it keeps.
 *
 * `versions` is 15.5 MB of the 15.8 MB `@openai/codex` answers with, and holds the manifest of every
 * release ever published. Nothing here reads it: a record is a channel pointing at a version, and
 * the version's publication time is in `time`. Parsing it cost 39 MB of objects, and storing it cost
 * a `JSON.stringify` and a `Buffer` of the whole body on the way to the snapshot -- about 85 MB
 * across one collection, on a process whose peak becomes its average.
 *
 * So the members are cut out of the text and only they are parsed, and the payload kept as evidence
 * is the same document without `versions`: 265 KB, every byte of it exactly as npm wrote it. A
 * snapshot of this source answers what a card rests on -- which channel moved, to what version,
 * published when -- and no longer carries the manifest of 4,959 releases nobody reads.
 */
export function parseNpm(payload: string): Collection {
  const members = jsonMembers(payload, ["name", "dist-tags", "time"]);
  const read = <T>(key: string): T => {
    const text = members[key];
    if (text === undefined) throw new SourceError("protocol", `npm document has no ${key}`);
    return JSON.parse(text) as T;
  };
  const data = npmPackage.parse({ name: read("name"), "dist-tags": read("dist-tags"), time: read("time") });
  return npmCollection(
    data.name,
    data["dist-tags"],
    (version) => publishedAt(data.time, data.name, version),
    JSON.stringify(data),
  );
}

/** What the last collection said each channel pointed at, and when that version was published. */
export type NpmChannels = Map<string, { version: string; published: string }>;

const distTags = z.record(z.string(), z.string());

/**
 * The full package document is the only place npm states when a version was published, and it
 * carries every version ever released: 14 MB for @openai/codex, 4,623 versions, about 85 MB of
 * memory each time it is read, every fifteen minutes. The channels alone are a 600-byte document.
 * They are read first, and the full document only when a channel points somewhere new, which is
 * the only time a publication date is not already known.
 */
export async function collectNpm(
  name: string,
  request: Fetch = fetch,
  cache?: HttpCache,
  known?: NpmChannels,
): Promise<Collection> {
  const encoded = name.replace("/", "%2F");
  if (known?.size) {
    const raw = await fetchText(
      `https://registry.npmjs.org/-/package/${encoded}/dist-tags`,
      { accept: "application/json" },
      request,
    );
    const tags = distTags.parse(JSON.parse(raw));
    const channels = Object.entries(tags).filter(([tag]) => !PLATFORM_TAG.test(tag));
    const unchanged = channels.every(([tag, version]) => known.get(tag)?.version === version);
    if (unchanged) {
      const published = (version: string): string => {
        const channel = [...known.values()].find((entry) => entry.version === version);
        if (!channel) throw new Error(`npm package ${name} has no publication time for ${version}`);
        return channel.published;
      };
      // The same document the full read keeps, assembled from what is already known: one source
      // answering with two shapes on alternate polls is a finding `source-shapes` would report, and
      // this source would have produced it for no reason other than which branch was taken.
      const time = Object.fromEntries(channels.map(([, version]) => [version, published(version)]));
      return npmCollection(name, tags, published, JSON.stringify({ name, "dist-tags": tags, time }));
    }
  }
  const url = `https://registry.npmjs.org/${encoded}`;
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
