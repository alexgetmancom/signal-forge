import { z } from "zod";
import type { Collection } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { fetchText } from "./http.js";

/**
 * The app a person actually opens is where a change reaches them first: a model, a mode or a
 * feature ships in a release before it is written about. Apple publishes the version, the release
 * date and the vendor's own notes for every listing, with no key and no scraping.
 */
export type WatchedApp = { id: string; name: string; vendor: string; appStoreId: string };

export const APP_STORE_APPS: readonly WatchedApp[] = [
  { id: "chatgpt", name: "ChatGPT", vendor: "OpenAI", appStoreId: "6448311069" },
  { id: "claude", name: "Claude", vendor: "Anthropic", appStoreId: "6473753684" },
  { id: "gemini", name: "Gemini", vendor: "Google", appStoreId: "6477489729" },
  { id: "grok", name: "Grok", vendor: "xAI", appStoreId: "6670324846" },
  { id: "deepseek", name: "DeepSeek", vendor: "DeepSeek", appStoreId: "6737597349" },
];

const lookupSchema = z.object({
  resultCount: z.number().int(),
  results: z.array(
    z.object({
      trackId: z.number().int(),
      trackName: z.string().min(1),
      version: z.string().min(1),
      currentVersionReleaseDate: z.string().min(1),
      releaseNotes: z.string().optional(),
      trackViewUrl: z.string().url(),
      sellerName: z.string().optional(),
      minimumOsVersion: z.string().optional(),
    }),
  ),
});

/**
 * Release notes are marketing copy as often as they are a changelog. They are kept as the record's
 * summary rather than being interpreted, and the line breaks Apple stores are flattened so one
 * release does not become twenty lines of card.
 */
function notes(value: string | undefined): string | undefined {
  const text = (value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-•*\u2022]\s*/, ""))
    .filter(Boolean)
    .join(" · ");
  return text ? text.slice(0, 600) : undefined;
}

export function parseAppStore(payload: string, app: WatchedApp): Collection {
  const data = lookupSchema.parse(JSON.parse(payload));
  const result = data.results[0];
  // An empty lookup is a failed observation, never an app that stopped existing.
  if (!result) throw new Error(`App Store returned no listing for ${app.name}`);
  return {
    source: `app:ios:${app.id}`,
    stream: "apps",
    url: result.trackViewUrl,
    raw: data,
    records: [
      {
        id: `ios:${result.trackId}`,
        name: `${app.name} for iOS`,
        version: result.version,
        released: result.currentVersionReleaseDate,
        maker: app.vendor,
        platform: "iOS",
        url: result.trackViewUrl,
        ...(notes(result.releaseNotes) ? { summary: notes(result.releaseNotes) } : {}),
        ...(result.minimumOsVersion ? { requires: `iOS ${result.minimumOsVersion}` } : {}),
      },
    ],
  };
}

export async function collectAppStore(app: WatchedApp, request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(app.appStoreId)}&country=us&entity=software`;
  return parseAppStore(await fetchText(url, { accept: "application/json" }, request, undefined, cache), app);
}
