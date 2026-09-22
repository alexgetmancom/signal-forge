import { z } from "zod";
import type { Collection } from "../events/types.js";
import type { Fetch } from "../http-client.js";

/**
 * The model lists of the coding subscriptions that resell other makers' models. A name lands in them
 * before most catalogues: `big-pickle` and `omen-alpha` were served under OpenCode with no maker, and
 * Command Code's CLI carried `thinkingmachines/inkling` on 2026-09-22 while nothing else here did.
 */

const listSchema = z.object({ data: z.array(z.object({ id: z.string().min(1) })).min(1) });

/** A free model a reader can use today, where "free" is the list's own word for it. */
export function isFreeModel(id: string): boolean {
  return /(?:[-:]free$|^big-pickle$)/i.test(id);
}

/** Small variants are not worth a headline even when free. */
/**
 * The model a free serving is of: `grok-4.7-free` is Grok 4.7, so its card joins the story the other
 * catalogues' `grok-4.7` already has rather than starting a second one.
 */
export function servedModel(id: string): string {
  return id.replace(/[-:]free$/i, "");
}

export function isSmallModel(id: string): boolean {
  return /-(?:nano|mini|lite|small|lightning|tiny)\b|\b\d{1,2}b\b/i.test(id);
}

async function openCodeList(
  source: "opencode-zen" | "opencode-go",
  url: string,
  page: string,
  request: Fetch,
): Promise<Collection> {
  const response = await request(url);
  if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
  const ids = [...new Set(listSchema.parse(await response.json()).data.map((model) => model.id))]
    // "test" and "test-novita-dsf4.1" are the operator's own plumbing.
    .filter((id) => !/^test\b/.test(id))
    .sort();
  return {
    source,
    stream: "api-models",
    url: page,
    raw: ids.join("\n"),
    records: ids.map((id) => ({
      id,
      name: id,
      model: servedModel(id),
      maker: "OpenCode",
      free: isFreeModel(id),
      headline: isFreeModel(id) && !isSmallModel(id),
    })),
  };
}

export function collectOpenCodeZen(request: Fetch = fetch): Promise<Collection> {
  return openCodeList("opencode-zen", "https://opencode.ai/zen/v1/models", "https://opencode.ai/zen", request);
}

export function collectOpenCodeGo(request: Fetch = fetch): Promise<Collection> {
  return openCodeList("opencode-go", "https://opencode.ai/zen/go/v1/models", "https://opencode.ai/go", request);
}

const MAKERS =
  "qwen|deepseek|google|meta|moonshotai|minimaxai|nvidia|poolside|sakana|stepfun|tencent|thinkingmachines|xai|xiaomi|zai-org|z-ai|meituan|inclusionai|openai|anthropic|mistralai|cohere|ai21|baidu|bytedance";

/**
 * Model ids in Command Code's CLI. The registry behind `--list-models` ships in the bundle, and it
 * holds ids the documentation page leaves out (`MiniMax-M3-Free`, `openai/gpt-5.6`). Case variants of
 * one id are one model.
 */
export function commandCodeModelIds(text: string): string[] {
  const ids = new Set<string>();
  for (const [id] of text.matchAll(new RegExp(`\\b(?:${MAKERS})/[A-Za-z][A-Za-z0-9._:-]{2,}`, "gi")))
    if (!/\/v\d+$/i.test(id)) ids.add(id.toLowerCase().replace(/[.:-]+$/, ""));
  for (const [, id] of text.matchAll(/"((?:claude|gpt)-[a-z0-9.-]*\d[a-z0-9.-]*)"/g))
    if (id && !/-\d{8}$/.test(id)) ids.add(id);
  return [...ids].sort();
}

const TAGS = "https://registry.npmjs.org/-/package/command-code/dist-tags";
let read: { version: string; collection: Collection } | null = null;

export async function collectCommandCodeModels(request: Fetch = fetch): Promise<Collection> {
  const version = ((await (await request(TAGS)).json()) as Record<string, string>).latest;
  if (!version) throw new Error("Command Code has no published version");
  if (read?.version === version) return read.collection;
  const response = await request(`https://registry.npmjs.org/command-code/-/command-code-${version}.tgz`);
  if (!response.ok) throw new Error(`Command Code ${version}: HTTP ${response.status}`);
  const text = Buffer.from(Bun.gunzipSync(new Uint8Array(await response.arrayBuffer()))).toString("latin1");
  const ids = commandCodeModelIds(text);
  if (ids.length < 10) throw new Error(`Command Code ${version} names ${ids.length} models`);
  const collection: Collection = {
    source: "command-code-models",
    stream: "api-models",
    url: "https://commandcode.ai/docs/reference/cli/models",
    raw: ids.join("\n"),
    records: ids.map((id) => ({
      id,
      name: id,
      model: servedModel(id.replace(/^[^/]+\//, "")),
      maker: "Command Code",
      free: isFreeModel(id),
      headline: isFreeModel(id) && !isSmallModel(id),
    })),
  };
  read = { version, collection };
  return collection;
}
