import { z } from "zod";
import type { Collection } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { fetchText } from "./http.js";

/**
 * OpenAI Codex usage-limit resets, as tracked by a third party that watches the OpenAI staff
 * account that announces them.
 *
 * This is the one surface here that reports what a subscriber can do right now rather than what a
 * vendor released: a reset returns usage to people who had run out. There is no first-party feed
 * for it — the announcements are posts by one person, and this tracker is the only place they are
 * kept with timestamps. Hence third-party authority and the weakest confidence label, even though
 * the underlying words are OpenAI's.
 *
 * Only executed resets become records. The tracker also publishes a scheduled reset and an
 * AI-classified "watch" forecast, and its own documentation says a passed schedule does not imply
 * completion and a watch is not an OpenAI commitment. Both are retained in the snapshot as
 * evidence and neither is allowed to tell a reader that their limits came back.
 */

const source = z.discriminatedUnion("type", [
  z.object({ type: z.literal("x_post"), author: z.string().min(1), url: z.string().url() }),
  z.object({ type: z.literal("observed"), url: z.string().url().nullish() }),
]);

const reset = z.object({
  id: z.string().min(1).max(64),
  reset_type: z.enum(["regular", "banked"]),
  announced_at: z.string().min(1),
  text: z.string(),
  source,
});

const listResponse = z.object({
  data: z.array(reset),
  pagination: z.object({ has_more: z.boolean(), next_cursor: z.string().nullish() }),
});

const statusResponse = z.object({
  data: z.object({
    scheduled_reset: z.unknown().nullish(),
    active_watch: z.unknown().nullish(),
    stats: z.object({
      total: z.number().int().min(0),
      last_reset_at: z.string().nullish(),
      days_since_last: z.number().min(0).nullish(),
      avg_interval_days: z.number().min(0).nullish(),
    }),
  }),
});

type Reset = z.infer<typeof reset>;

const SITE = "https://codex-resets.com";
/** 100 is the API's own page limit; ten pages is a thousand announcements at a rate of one a week. */
const MAX_PAGES = 10;

/** How the announcement reached the tracker, in the words a reader needs to weigh it. */
function announcement(entry: Reset): string {
  return entry.source.type === "x_post" ? `Posted by @${entry.source.author} on X` : "Observed without an announcement";
}

export function resetRecords(entries: Reset[]): Collection["records"] {
  const records = new Map<string, Collection["records"][number]>();
  for (const entry of entries) {
    const announcedAt = new Date(entry.announced_at);
    if (Number.isNaN(announcedAt.getTime())) throw new Error("Codex reset announcement carries an unreadable time");
    records.set(entry.id, {
      id: entry.id,
      name:
        entry.reset_type === "banked" ? "Codex banked reset credit granted" : "Codex usage limits reset for everyone",
      url: entry.source.url ?? SITE,
      maker: "OpenAI",
      // Minute precision in UTC: this is read on a card, and the exact second of a post is in
      // the retained snapshot for anyone who needs it.
      announced: `${announcedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`,
      resetType: entry.reset_type,
      announcement: announcement(entry),
      // The post itself, which is the whole of what the announcement says.
      summary: entry.text.trim().slice(0, 600) || null,
    });
  }
  return [...records.values()].sort((a, b) => String(a.announced).localeCompare(String(b.announced)));
}

/**
 * The full history in one observation, oldest first, so the first collection stores every past
 * reset as the baseline and only genuinely new announcements ever speak.
 */
export async function collectCodexResets(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  const pages: string[] = [];
  const entries: Reset[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${SITE}/api/v1/resets?limit=100&order=asc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    // A page is only conditionally requested when it is the whole history: a cursor page is keyed
    // on a cursor the next observation will not reuse.
    const body = await fetchText(url, {}, request, undefined, cursor ? undefined : cache);
    pages.push(body);
    const parsed = listResponse.parse(JSON.parse(body));
    entries.push(...parsed.data);
    cursor = parsed.pagination.has_more ? (parsed.pagination.next_cursor ?? null) : null;
    if (!cursor) break;
  }
  if (cursor) throw new Error("Codex reset history exceeds the pages this collector reads");
  const statusBody = await fetchText(`${SITE}/api/v1/status`, {}, request);
  const status = statusResponse.parse(JSON.parse(statusBody));
  const records = resetRecords(entries);
  // An empty answer is a broken observation, never a history in which no reset ever happened.
  if (!records.length) throw new Error("Codex reset history came back empty");
  if (status.data.stats.total > records.length)
    throw new Error(`Codex reset history is short: ${records.length} of ${status.data.stats.total} announcements`);
  return {
    source: "codex-resets",
    stream: "resets",
    url: SITE,
    // Announcements are never withdrawn, and a truncated page must not read as a deleted history.
    appendOnly: true,
    records,
    raw: {
      resets: entries,
      stats: status.data.stats,
      // Retained as evidence, deliberately not records: a forecast is not a reset.
      scheduled_reset: status.data.scheduled_reset ?? null,
      active_watch: status.data.active_watch ?? null,
      pages: pages.length,
    },
  };
}
