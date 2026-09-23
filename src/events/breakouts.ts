import type { Database } from "bun:sqlite";
import type { Destination } from "../config.js";
import { readState, writeState } from "../storage/appState.js";
import { isUnfollowedMakerAtAReseller, resellerMaker } from "./signals.js";
import type { Event } from "./types.js";
import { wasReleasedLongBefore } from "./worth.js";

/**
 * A small company's model taking off, told the moment it does.
 *
 * A reseller listing a model from a maker nobody follows is a line in the scouts' morning rather
 * than a card: five of the six such listings in the week to 2026-09-19 were a catalogue growing. The
 * sixth was Typesafe's Jev, which reached the Vercel gateway on 2026-09-16 at 23:50, models.dev and
 * OpenRouter the next afternoon, and had thirty repositories built on it within three days. What set
 * it apart was not its maker but what happened next, and every part of that is already collected:
 * another catalogue listing it, repositories named after it, a front-page story.
 *
 * When one of those happens the arrival becomes a card after all, and its maker is followed from
 * then on, so the next model is a card on arrival. The list of labs worth hearing from grows with
 * what the field does rather than with what someone remembered to add.
 */
const FOLLOWED_PREFIX = "followed-maker:";
const BREAKOUT_PREFIX = "breakout:";
/** An arrival older than this is not taking off; it took off, and the card would be late news. */
const WATCH_MS = 48 * 3_600_000;
/** How far back a name must be absent for repositories and stories using it to be about this model. */
const NOVELTY_MS = 30 * 24 * 3_600_000;
/** Repositories named after a model in the days after it appears: three is a pattern, one a hobby. */
const REPOSITORIES = 3;
/**
 * Catalogues that copy other catalogues. models.dev lists what Vercel and OpenRouter list within
 * hours, so on 2026-09-19 it made Mixedbread's Toast, Quiver's Arrow and Unbiased's Pareto look like
 * breakouts; a second listing only counts when somebody chose to host the model.
 */
const MIRRORS = new Set(["models-dev"]);
/** Words too common to identify a model by. */
const GENERIC = new Set([
  "model",
  "chat",
  "instruct",
  "preview",
  "latest",
  "free",
  "mini",
  "pro",
  "flash",
  "lite",
  "max",
  "plus",
  "turbo",
  "base",
  "large",
  "small",
  "medium",
]);

export type Breakout = { catalogues: string[]; repositories: number; story: boolean; at: string };

/** One maker however a catalogue spells it: `typesafe-ai` on Vercel and `~typesafe` on OpenRouter. */
function normalMaker(maker: string): string {
  const letters = maker.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return letters.length > 4 ? letters.replace(/(?:ai|labs?)$/, "") : letters;
}

/** True once a maker's model has taken off here; its next arrival is a card like a followed lab's. */
export function isLearnedMaker(db: Database, maker: string | null): boolean {
  return maker !== null && readState(db, `${FOLLOWED_PREFIX}${normalMaker(maker)}`) !== null;
}

export function breakoutOf(db: Database, eventId: number): Breakout | null {
  const stored = readState(db, `${BREAKOUT_PREFIX}${eventId}`);
  return stored ? (JSON.parse(stored) as Breakout) : null;
}

/** The word a model is called by: "jev" for Typesafe's Jev, "toast" for Mixedbread's Toast 1. */
function nameToken(event: Event): string | null {
  const record = JSON.parse(event.after_json ?? "{}") as { id?: unknown; name?: unknown };
  const name = String(record.name ?? "").replace(/^[^:]{1,40}:\s+/, "");
  const id =
    String(record.id ?? event.entity_id)
      .split("/")
      .at(-1) ?? "";
  for (const word of `${name} ${id}`.toLowerCase().split(/[^a-z0-9]+/))
    if (word.length >= 3 && !/^\d+$/.test(word) && !GENERIC.has(word)) return word;
  return null;
}

function mentions(token: string, text: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, "i").test(text);
}

/** What the field did with this model since it appeared, measured against the month before. */
function measure(db: Database, event: Event, token: string, now: number): Breakout {
  const arrived = Date.parse(event.detected_at);
  const since = new Date(arrived - NOVELTY_MS).toISOString();
  const catalogues = new Set(
    db
      .query<{ source: string; entity_id: string; after_json: string | null }, [string, string]>(
        `SELECT source,entity_id,after_json FROM events
         WHERE kind='new' AND stream IN ('api-models','openrouter') AND source<>? AND detected_at>=?`,
      )
      .all(event.source, event.detected_at)
      .filter((row) => {
        if (MIRRORS.has(row.source)) return false;
        const record = JSON.parse(row.after_json ?? "{}") as { name?: unknown };
        return mentions(token, `${row.entity_id} ${String(record.name ?? "")}`);
      })
      .map((row) => row.source),
  );
  // A name the field already used before this model existed says nothing about it: "arrow" has been
  // a repository name for years, "jev" had not.
  const around = (where: string) =>
    db
      .query<{ entity_id: string; after_json: string | null; detected_at: string }, [string]>(
        `SELECT entity_id,after_json,detected_at FROM events WHERE kind='new' AND ${where} AND detected_at>=?`,
      )
      .all(since);
  const split = (
    rows: { entity_id: string; after_json: string | null; detected_at: string }[],
    text: (row: (typeof rows)[number]) => string,
  ) => {
    const matching = rows.filter((row) => mentions(token, text(row)));
    return {
      before: matching.filter((row) => Date.parse(row.detected_at) < arrived).length,
      after: new Set(matching.filter((row) => Date.parse(row.detected_at) >= arrived).map((row) => row.entity_id)).size,
    };
  };
  const repos = split(around("source LIKE 'discovery:github%'"), (row) => row.entity_id.split("/").at(-1) ?? "");
  const stories = split(around("source='hackernews'"), (row) => {
    const record = JSON.parse(row.after_json ?? "{}") as { name?: unknown };
    return String(record.name ?? "");
  });
  return {
    catalogues: [...catalogues].sort(),
    repositories: repos.before ? 0 : repos.after,
    story: !stories.before && stories.after > 0,
    at: new Date(now).toISOString(),
  };
}

function tookOff(measured: Breakout): boolean {
  return measured.catalogues.length > 0 || measured.repositories >= REPOSITORIES || measured.story;
}

/**
 * Watch every small company's arrival from the last two days and, once one takes off, send it to
 * the rooms that carry sightings and follow its maker. Returns the events that broke out.
 */
export function detectBreakouts(db: Database, destinations: readonly Destination[], now = Date.now()): number[] {
  const targets = destinations.filter((destination) => destination.signals.includes("codename"));
  const candidates = db
    .query<Event, [string, string]>(
      "SELECT * FROM events WHERE kind='new' AND stream IN ('api-models','openrouter') AND detected_at>=? AND detected_at<=? ORDER BY id",
    )
    .all(new Date(now - WATCH_MS).toISOString(), new Date(now).toISOString())
    .filter((event) => isUnfollowedMakerAtAReseller(event) && !breakoutOf(db, event.id))
    // A model that was already out is not taking off. Meta's Muse Glimmer 30B, six weeks old and
    // sold by five catalogues, reached Azure on 2026-09-21 and was carded because its Hacker News
    // thread was on the front page; the thread was about the model, not about Azure listing it.
    .filter((event) => !wasReleasedLongBefore(db, event))
    // A model that already reached a reader as a card is not news again when it takes off.
    .filter(
      (event) =>
        !db
          .query("SELECT 1 FROM batch_events be JOIN deliveries d ON d.batch_id=be.batch_id WHERE be.event_id=?")
          .get(event.id),
    );
  const broke: number[] = [];
  for (const event of candidates) {
    const maker = resellerMaker(event);
    // A maker that took off with another model already sends its arrivals as cards.
    if (isLearnedMaker(db, maker)) continue;
    const token = nameToken(event);
    if (!token) continue;
    const measured = measure(db, event, token, now);
    if (!tookOff(measured)) continue;
    db.transaction(() => {
      writeState(db, `${BREAKOUT_PREFIX}${event.id}`, JSON.stringify(measured));
      if (maker) writeState(db, `${FOLLOWED_PREFIX}${normalMaker(maker)}`, measured.at);
      if (!targets.length) return;
      const batch = db
        .query<{ id: number }, [string, string]>(
          "INSERT INTO batches(source,digest,ready_at) VALUES(?,0,?) RETURNING id",
        )
        .get(event.source, measured.at);
      if (!batch) throw new Error("Breakout batch insert failed");
      const record = JSON.parse(event.after_json ?? "{}") as { url?: unknown };
      db.query("INSERT INTO batch_events(batch_id,event_id,url,signal) VALUES(?,?,?,'codename')").run(
        batch.id,
        event.id,
        typeof record.url === "string" ? record.url : "",
      );
      for (const destination of targets)
        db.query("INSERT INTO batch_targets(batch_id,destination_id,destination_json) VALUES(?,?,?)").run(
          batch.id,
          destination.id,
          JSON.stringify(destination),
        );
    })();
    broke.push(event.id);
  }
  return broke;
}

/** The line above a breakout's card, in the counts that made it one: "🔥 Typesafe Jev is taking off". */
export function breakoutLine(event: Event, breakout: Breakout): string {
  const record = JSON.parse(event.after_json ?? "{}") as { name?: unknown };
  const name = String(record.name ?? event.entity_id).replace(/^[^:]{1,40}:\s+/, "");
  const maker = (resellerMaker(event) ?? "").replace(/^~/, "").replace(/[-_](?:ai|labs?)$/i, "");
  const label =
    maker && !name.toLowerCase().includes(maker.toLowerCase())
      ? `${maker.charAt(0).toUpperCase()}${maker.slice(1)} ${name}`
      : name;
  const reasons = [
    ...(breakout.catalogues.length ? [`listed by ${breakout.catalogues.length + 1} catalogues`] : []),
    ...(breakout.repositories ? [`${breakout.repositories} new GitHub projects`] : []),
    ...(breakout.story ? ["on the Hacker News front page"] : []),
  ];
  return `🔥 ${label} is taking off: ${reasons.join(" · ")}`;
}
