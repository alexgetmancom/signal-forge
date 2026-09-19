import { z } from "zod";
import type { Collection } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { fetchText } from "./http.js";

export function codexPages(index: string): { name: string; url: string }[] {
  const pages = new Map<string, { name: string; url: string }>();
  for (const match of index.matchAll(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g)) {
    const url = new URL(match[2] ?? "");
    if (
      url.origin !== "https://learn.chatgpt.com" ||
      !url.pathname.startsWith("/docs/") ||
      !url.pathname.endsWith(".md")
    )
      continue;
    if (url.pathname.endsWith("codex-manual.md")) continue; // Generated duplicate of individual guides.
    pages.set(url.href, { name: match[1] ?? url.pathname, url: url.href });
  }
  if (!pages.size || pages.size > 200) throw new Error("Public page Codex index invalid or exceeds 200 pages");
  return [...pages.values()].sort((a, b) => a.url.localeCompare(b.url));
}
export function markdownParagraphs(text: string): string[] {
  if (!text.trimStart().startsWith("# ") || /<!doctype html/i.test(text))
    throw new Error("Public page expected Markdown");
  return text
    .split(/\n\s*\n/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s && !s.startsWith("> For the complete documentation index"));
}
export async function collectCodexDocs(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  const index = await fetchText("https://learn.chatgpt.com/docs/llms.txt", {}, request, undefined, cache);
  const pages = codexPages(index);
  const records: Collection["records"] = [];
  const raw: Record<string, string> = { index };
  let bytes = index.length;
  // A failed page aborts the entire observation; it cannot imply deleted documentation.
  for (let offset = 0; offset < pages.length; offset += 4) {
    const results = await Promise.all(
      pages.slice(offset, offset + 4).map(async (page) => {
        const text = await fetchText(page.url, {}, request, undefined, cache);
        return { page, text, strings: markdownParagraphs(text) };
      }),
    );
    for (const { page, text, strings } of results) {
      bytes += text.length;
      if (bytes > 15_000_000) throw new Error("Public page Codex documentation exceeds 15 MB");
      raw[page.url] = text;
      records.push({ id: page.url, name: page.name, url: page.url.replace(/\.md(?=\?|$)/, ""), strings });
    }
  }
  return { source: "codex-docs", stream: "web", url: "https://developers.openai.com/codex/", records, raw };
}

const CODEX_MODELS_URL = "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";
const codexModelsSchema = z.object({
  models: z
    .array(
      z
        .object({
          slug: z.string().min(1),
          display_name: z.string().optional(),
          visibility: z.string().optional(),
          available_in_plans: z.array(z.string()).optional(),
          context_window: z.number().optional(),
          supported_in_api: z.boolean().optional(),
        })
        .passthrough(),
    )
    .min(1),
});

/**
 * The models the Codex client ships knowing about, read from its repository. A slug lands here
 * before the model is announced: on 2026-09-19 the file held gpt-6-astra and two hidden
 * "Daybreak" models no catalogue listed. The commit feed watched `codex-rs/core/models.json`, a
 * path the file had left, so none of this reached anyone. Only the fields that say a model is
 * coming are kept; instructions and tool settings change with every prompt edit.
 */
export function parseCodexModels(text: string): Collection {
  const models = codexModelsSchema.parse(JSON.parse(text)).models;
  return {
    source: "codex-models",
    stream: "github",
    url: "https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json",
    raw: text,
    records: models.map((model) => ({
      id: model.slug,
      name: model.display_name ?? model.slug,
      maker: "OpenAI",
      visibility: model.visibility ?? null,
      plans: [...(model.available_in_plans ?? [])].sort(),
      context: model.context_window ?? null,
      api: model.supported_in_api ?? null,
    })),
  };
}

export async function collectCodexModels(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseCodexModels(await fetchText(CODEX_MODELS_URL, {}, request, undefined, cache));
}
