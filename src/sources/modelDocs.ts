import { z } from "zod";
import type { Collection, RecordData } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { fetchText } from "./http.js";

/**
 * Vendor documentation, read as evidence rather than as an announcement. A page here says a
 * capability is documented, which is weaker than a release and often earlier: the entry exists
 * before the post that points at it. Nothing in this module carries a publication date, so it
 * belongs to the `web` stream and never becomes a launch on its own.
 */

const COHERE_CHANGELOG_INDEX_URL = "https://docs.cohere.com/changelog/llms.txt";
const COHERE_CHANGELOG_URL = "https://docs.cohere.com/changelog";

const entrySchema = z.object({ title: z.string().min(1), url: z.url(), summary: z.string() });

/**
 * Cohere publishes an agent-readable index of its changelog: one line per entry, with the title,
 * the address of the entry's own Markdown and a one-sentence summary. The site also offers the
 * same changelog as RSS, which arrives with unterminated CDATA and fails XML validation, so the
 * index is the only machine-readable form of this changelog that parses.
 */
export function parseCohereChangelog(markdown: string): Collection {
  const records = [...markdown.matchAll(/^-\s+\[([^\]]+)\]\((https:\/\/[^)]+)\)(?::\s*(.*))?$/gm)].map((match) => {
    const entry = entrySchema.parse({
      title: (match[1] ?? "").trim(),
      url: (match[2] ?? "").replace(/\.md$/, ""),
      summary: (match[3] ?? "").trim(),
    });
    return {
      id: new URL(entry.url).pathname,
      name: entry.title,
      url: entry.url,
      maker: "Cohere",
      ...(entry.summary ? { summary: entry.summary.slice(0, 1_200) } : {}),
    } satisfies RecordData;
  });
  if (!records.length) throw new Error("cohere-changelog: index listed no entries");
  return {
    source: "cohere-changelog",
    stream: "web",
    url: COHERE_CHANGELOG_URL,
    raw: records,
    appendOnly: true,
    trackChanges: true,
    records,
  };
}

export async function collectCohereChangelog(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseCohereChangelog(await fetchText(COHERE_CHANGELOG_INDEX_URL, {}, request, undefined, cache));
}
