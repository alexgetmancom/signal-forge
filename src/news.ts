import type { Database } from "bun:sqlite";
import { SIGNAL_CLASSES, type SignalClass, signalClass } from "./events/signals.js";
import type { Event } from "./events/types.js";
import { listStories } from "./stories.js";

/**
 * What came out over a window, in the shape a person asks for it: "what was news today".
 *
 * `events` answers with the last N rows, and on an ordinary day 1500 of them are scoreboard moves.
 * The news is what reached a reader, so this starts from sent messages, names the classes each one
 * carried, and puts the raw event volume beside it per class so the noise is still visible.
 */
export type NewsReport = {
  since: string;
  hours: number;
  signal: SignalClass | null;
  totals: { events: number; messages: number; stories: number };
  classes: { signal: string; events: number; delivered: number; topSources: { source: string; events: number }[] }[];
  messages: {
    sentAt: string;
    destinations: string[];
    signals: string[];
    events: number;
    headline: string | null;
    items: NewsItem[];
  }[];
  stories: {
    id: string;
    title: string;
    vendor: string;
    confidence: string;
    sources: string[];
    firstSeenAt: string;
    updatedAt: string;
  }[];
};

export type NewsItem = { label: string | null; title: string; description: string | null; url: string | null };

const DESCRIPTION_LIMIT = 400;
const clip = (text: string): string =>
  text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT - 1).trimEnd()}…` : text;
const orNull = (text: string | undefined): string | null => (text?.trim() ? text.trim() : null);

type Embed = { author?: { name?: string }; title?: string; description?: string; url?: string };

/**
 * A sent body is what the platform was handed: Discord embeds as JSON, or plain text. A reader wants
 * the title and what it says, not the transport, so both shapes come back as the same items.
 */
export function readMessage(body: string): { headline: string | null; items: NewsItem[] } {
  if (body.startsWith("{")) {
    try {
      const payload = JSON.parse(body) as { content?: string; embeds?: Embed[] };
      const headline = orNull(payload.content?.split("\n")[0]?.replace(/<@&?\d+>/g, ""));
      const items = (payload.embeds ?? []).map((embed) => ({
        label: orNull(embed.author?.name),
        title: embed.title?.trim() || embed.author?.name?.trim() || "(untitled)",
        description: embed.description?.trim() ? clip(embed.description.trim()) : null,
        url: orNull(embed.url),
      }));
      return { headline, items };
    } catch {
      // Not JSON after all; read it as text.
    }
  }
  // Text cards: a header, tags, a blank line, then title, details, link and footer.
  const blocks = body.split(/\n\s*\n/);
  const header = blocks.length > 1 ? (blocks.shift() ?? "") : "";
  const lines = blocks
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const url = lines.find((line) => /^https?:\/\//.test(line)) ?? null;
  const rest = lines.filter((line) => line !== url && !line.startsWith("Signal Forge ·"));
  return {
    headline: orNull(header.split("\n")[0]),
    items: [{ label: null, title: rest[0] ?? "(untitled)", description: orNull(clip(rest.slice(1).join("\n"))), url }],
  };
}

export function isSignalClass(value: string): value is SignalClass {
  return (SIGNAL_CLASSES as readonly string[]).includes(value);
}

export function news(
  db: Database,
  input: { hours: number; signal?: SignalClass | undefined },
  now = Date.now(),
): NewsReport {
  const since = new Date(now - input.hours * 3_600_000).toISOString();
  const wanted = input.signal ?? null;

  const events = db
    .query<Event & { delivered: number }, [string]>(
      `SELECT e.*, EXISTS(SELECT 1 FROM delivery_events de JOIN deliveries d ON d.id=de.delivery_id
                          WHERE de.event_id=e.id AND d.status='sent') AS delivered
       FROM events e WHERE e.detected_at>=?`,
    )
    .all(since);
  const classOf = new Map<number, string>();
  const classes = new Map<string, { events: number; delivered: number; sources: Map<string, number> }>();
  for (const event of events) {
    const signal = signalClass(event) || "unclassified";
    classOf.set(event.id, signal);
    const held = classes.get(signal) ?? { events: 0, delivered: 0, sources: new Map() };
    held.events += 1;
    if (event.delivered) held.delivered += 1;
    held.sources.set(event.source, (held.sources.get(event.source) ?? 0) + 1);
    classes.set(signal, held);
  }

  // A message's events can predate the window (a digest sealed late); classify those on demand.
  const sent = db
    .query<
      { id: number; destination_id: string; body: string; updated_at: string; event_ids: string | null },
      [string]
    >(
      `SELECT d.id,d.destination_id,d.body,d.updated_at,
              (SELECT group_concat(de.event_id) FROM delivery_events de WHERE de.delivery_id=d.id) AS event_ids
       FROM deliveries d WHERE d.status='sent' AND d.updated_at>=? ORDER BY d.updated_at DESC, d.id DESC`,
    )
    .all(since);
  const lookup = db.query<Event, [number]>("SELECT * FROM events WHERE id=?");
  const classify = (id: number): string => {
    const known = classOf.get(id);
    if (known) return known;
    const event = lookup.get(id);
    const signal = event ? signalClass(event) || "unclassified" : "unclassified";
    classOf.set(id, signal);
    return signal;
  };

  // The same text sent to two channels is one piece of news.
  const byBody = new Map<string, NewsReport["messages"][number]>();
  for (const row of sent) {
    const ids = row.event_ids ? row.event_ids.split(",").map(Number) : [];
    const signals = [...new Set(ids.map(classify))].sort();
    if (wanted && !signals.includes(wanted)) continue;
    const held = byBody.get(row.body);
    if (held) {
      if (!held.destinations.includes(row.destination_id)) held.destinations.push(row.destination_id);
      continue;
    }
    byBody.set(row.body, {
      sentAt: row.updated_at,
      destinations: [row.destination_id],
      signals,
      events: ids.length,
      ...readMessage(row.body),
    });
  }

  const stories = listStories(db, { since, limit: 100 }).map((story) => ({
    id: story.id,
    title: story.title,
    vendor: story.vendor,
    confidence: story.confidence,
    sources: story.sources,
    firstSeenAt: story.firstSeenAt,
    updatedAt: story.updatedAt,
  }));

  const classRows = [...classes.entries()]
    .filter(([signal]) => !wanted || signal === wanted)
    .map(([signal, counts]) => ({
      signal,
      events: counts.events,
      delivered: counts.delivered,
      topSources: [...counts.sources.entries()]
        .sort((one, other) => other[1] - one[1])
        .slice(0, 5)
        .map(([source, count]) => ({ source, events: count })),
    }))
    .sort((one, other) => other.delivered - one.delivered || other.events - one.events);

  return {
    since,
    hours: input.hours,
    signal: wanted,
    totals: {
      events: classRows.reduce((sum, row) => sum + row.events, 0),
      messages: byBody.size,
      stories: stories.length,
    },
    classes: classRows,
    messages: [...byBody.values()],
    stories,
  };
}
