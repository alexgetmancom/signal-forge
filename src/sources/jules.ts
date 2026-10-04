import type { Collection, RecordData } from "../events/types.js";
import { SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { publishedDate } from "./feeds.js";
import { decodeHtml } from "./html.js";
import { fetchText } from "./http.js";

/**
 * Jules, Google's coding agent, and the model underneath it.
 *
 * A lagging signal, deliberately kept as one. Its model entries are "Gemini 3 Flash is now the base
 * model in Jules" on 2026-01-30 and "Gemini 3.1 Pro is now available in Jules" on 2026-03-09 -- the
 * second of those was seven months old while the API catalogue was on 3.8. So nothing here is early
 * and a reader must not take it as such: what it answers is whether a model has reached the product
 * a person actually codes in, which is a different fact from the model existing, and the only place
 * that fact is published.
 *
 * The changelog index is one small page listing every entry with its date, so the entries are read
 * from it directly rather than followed one by one.
 */
const CHANGELOG_URL = "https://jules.google/docs/changelog/";

/** `<a href="/docs/changelog/2026-03-09">` with a title span and a date span inside it. */
const ENTRY =
  /<a\s+href="\/docs\/changelog\/(\d{4}-\d{2}-\d{2})"[^>]*>\s*<span[^>]*changelog-title[^>]*>([\s\S]*?)<\/span>\s*<span[^>]*changelog-date[^>]*>([\s\S]*?)<\/span>/g;

export function parseJulesChangelog(html: string): Collection {
  const records = [...html.matchAll(ENTRY)].map((match) => {
    const slug = match[1] ?? "";
    const title = decodeHtml((match[2] ?? "").replaceAll(/<[^>]+>/g, "")).trim();
    const date = decodeHtml((match[3] ?? "").replaceAll(/<[^>]+>/g, "")).trim();
    return {
      id: `jules:${slug}`,
      name: title,
      maker: "Google",
      url: `https://jules.google/docs/changelog/${slug}`,
      published: publishedDate(date),
    } satisfies RecordData;
  });
  if (!records.length) throw new SourceError("missing-content", "jules-changelog: the index listed no dated entries");
  return { source: "jules-changelog", stream: "news", url: CHANGELOG_URL, raw: html, trackChanges: true, records };
}

export async function collectJulesChangelog(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseJulesChangelog(await fetchText(CHANGELOG_URL, {}, request, undefined, cache));
}
