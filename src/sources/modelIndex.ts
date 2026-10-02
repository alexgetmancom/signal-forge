/**
 * The index a maker keeps of its own model documentation.
 *
 * Every model page a maker publishes is listed on one small page beside it: OpenAI's is 12 KB of
 * Markdown at `/api/docs/models/all.md`, Anthropic's is the comparison table in its models
 * overview. Both name a model the moment its page ships, which is what the changelog beside them
 * only claims afterwards in a sentence somebody has to write -- on 2026-09-29 the `gpt-6.1-sol`
 * page and its index entry were live while the announcement post was still an hour away.
 *
 * This is the half of discovery the documentation probe cannot reach. The probe asks whether an
 * address it guessed answers, so it finds only names that can be guessed; an index answers with
 * every name at once, including the one nobody could have spelled. They are both read, because the
 * probe can find a page that exists before the index links it and the index finds the rest.
 */

import type { Collection, RecordData } from "../events/types.js";
import { SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { fetchText } from "./http.js";

const OPENAI_MODEL_INDEX_URL = "https://developers.openai.com/api/docs/models/all.md";
const OPENAI_MODELS_URL = "https://developers.openai.com/api/docs/models";
const ANTHROPIC_MODEL_INDEX_URL = "https://platform.claude.com/docs/en/models/overview.md";
const ANTHROPIC_MODELS_URL = "https://platform.claude.com/docs/en/models/overview";

/** A line of OpenAI's index: a link to a model page, and the sentence the maker gives it. */
const OPENAI_ENTRY = /^-\s*\[([^\]]+)\]\(\/api\/docs\/models\/([a-z0-9][a-z0-9.-]*)\.md\)\s*:?\s*(.*)$/gim;

/**
 * Anthropic's overview names each model in every spelling a platform wants -- the API id, the
 * Bedrock id, the Vertex id -- so one model appears a dozen times, and the dated snapshot
 * `claude-haiku-4-5-20251001` is the same model as `claude-haiku-4-5`. The date comes off and the
 * set does the rest.
 */
const ANTHROPIC_ID = /`(?:anthropic\.)?(claude-[a-z]+-\d+(?:-\d+)?)(?:[-@]\d{8})?`/gi;

/** A model page's own address, which is where a reader is sent. */
function openAIPageUrl(slug: string): string {
  return `${OPENAI_MODELS_URL}/${slug}`;
}

export function parseOpenAIModelIndex(markdown: string): Collection {
  const records: RecordData[] = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(OPENAI_ENTRY)) {
    const slug = (match[2] ?? "").toLowerCase();
    // `all` and `compare` are the index pages themselves, listed among the models they index.
    if (!slug || slug === "all" || slug === "compare" || seen.has(slug)) continue;
    seen.add(slug);
    const summary = (match[3] ?? "").trim();
    records.push({
      id: slug,
      name: (match[1] ?? slug).trim(),
      url: openAIPageUrl(slug),
      maker: "OpenAI",
      source: "documentation",
      ...(summary ? { summary } : {}),
    });
  }
  if (!records.length) throw new SourceError("empty", "OpenAI model index named no model");
  return { source: "openai-model-index", stream: "api-models", url: OPENAI_MODELS_URL, raw: [...seen].sort(), records };
}

export function parseAnthropicModelIndex(markdown: string): Collection {
  const records: RecordData[] = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(ANTHROPIC_ID)) {
    const id = (match[1] ?? "").toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    records.push({
      id,
      // `claude-opus-5-5` is how Anthropic writes it everywhere it can be called.
      name: id,
      url: ANTHROPIC_MODELS_URL,
      maker: "Anthropic",
      source: "documentation",
    });
  }
  if (!records.length) throw new SourceError("empty", "Anthropic model index named no model");
  return {
    source: "anthropic-model-index",
    stream: "api-models",
    url: ANTHROPIC_MODELS_URL,
    raw: [...seen].sort(),
    records,
  };
}

export async function collectOpenAIModelIndex(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseOpenAIModelIndex(await fetchText(OPENAI_MODEL_INDEX_URL, {}, request, undefined, cache));
}

export async function collectAnthropicModelIndex(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseAnthropicModelIndex(await fetchText(ANTHROPIC_MODEL_INDEX_URL, {}, request, undefined, cache));
}
