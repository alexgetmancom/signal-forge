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
 * Resets arrive in two steps, because the announcer works in two steps: he either promises one
 * ("limits will be reset in the next hour") or reports one already applied ("reset all
 * propagated"). Both are news, so both are records — one announcement, carrying the stage it has
 * reached. A promise says it is a promise and never claims the limits came back; when the tracker
 * stops holding it as scheduled, the same record moves to applied and that move is the second card.
 *
 * The AI-classified "watch" forecast is not a record at all. Their own documentation says it is
 * not an OpenAI commitment, and a guess standing beside these two costs both their weight; it is
 * retained in the snapshot as evidence.
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

const scheduled = z.object({
  id: z.string().min(1).max(64),
  reset_type: z.enum(["regular", "banked"]),
  announced_at: z.string().min(1),
  scheduled_for: z.string().nullish(),
  text: z.string(),
  source,
});

const listResponse = z.object({
  data: z.array(reset),
  pagination: z.object({ has_more: z.boolean(), next_cursor: z.string().nullish() }),
});

const statusResponse = z.object({
  data: z.object({
    scheduled_reset: scheduled.nullish(),
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
type Scheduled = z.infer<typeof scheduled>;

/** What stage of its own announcement a reset has reached, in the words the card prints. */
const ANNOUNCED = "Announced, not applied yet";
const APPLIED = "Applied";

const SITE = "https://codex-resets.com";
/** 100 is the API's own page limit; ten pages is a thousand announcements at a rate of one a week. */
const MAX_PAGES = 10;

/** UTC to the minute: this is read on a card, and the exact second is in the retained snapshot. */
function minute(time: string): string {
  const parsed = new Date(time);
  if (Number.isNaN(parsed.getTime())) throw new Error("Codex reset announcement carries an unreadable time");
  return `${parsed.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** How the announcement reached the tracker, in the words a reader needs to weigh it. */
function announcement(entry: Reset): string {
  return entry.source.type === "x_post" ? `Posted by @${entry.source.author} on X` : "Observed without an announcement";
}

function resetRecords(entries: Reset[], pending: Scheduled | null = null): Collection["records"] {
  const records = new Map<string, Collection["records"][number]>();
  for (const entry of [...entries, ...(pending ? [pending] : [])]) {
    const applied = entry.id !== pending?.id;
    const banked = entry.reset_type === "banked";
    records.set(entry.id, {
      id: entry.id,
      name: applied
        ? banked
          ? "Codex banked reset credit granted"
          : "Codex usage limits reset for everyone"
        : banked
          ? "Codex banked reset credit announced"
          : "Codex usage limits reset announced",
      url: entry.source.url ?? SITE,
      maker: "OpenAI",
      // The stage is the field that moves: one announcement, promised and then applied. It is
      // deliberately the only field that can change, so the second card is about exactly that.
      stage: applied ? APPLIED : ANNOUNCED,
      announced: minute(entry.announced_at),
      ...(!applied && pending?.scheduled_for ? { expected: minute(pending.scheduled_for) } : {}),
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
  const records = resetRecords(entries, status.data.scheduled_reset ?? null);
  // An empty answer is a broken observation, never a history in which no reset ever happened.
  if (!records.length) throw new Error("Codex reset history came back empty");
  // A scheduled announcement is excluded from the tracker's own count, so it is excluded here too.
  if (status.data.stats.total > entries.length)
    throw new Error(`Codex reset history is short: ${entries.length} of ${status.data.stats.total} announcements`);
  return {
    source: "codex-resets",
    stream: "resets",
    url: SITE,
    // Announcements are never withdrawn, and a truncated page must not read as a deleted history.
    appendOnly: true,
    // The one change worth an event: a promised reset becoming an applied one.
    trackChanges: true,
    records,
    raw: {
      resets: entries,
      stats: status.data.stats,
      scheduled_reset: status.data.scheduled_reset ?? null,
      // Retained as evidence, deliberately not a record: a guess is not an announcement.
      active_watch: status.data.active_watch ?? null,
      pages: pages.length,
    },
  };
}
