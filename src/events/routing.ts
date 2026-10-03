import type { Database } from "bun:sqlite";
import type { Destination } from "../config.js";
import { storageFailure } from "../failure.js";
import { classify } from "./classify.js";
import { isRoutine } from "./interpretation.js";
import { hasNotificationContent } from "./notification.js";
import { isStealthLaunch } from "./resellers.js";
import type { SignalClass } from "./signals.js";
import type { Collection, Event } from "./types.js";

/**
 * From an emitted event to the batch it is told in: its class, its pace and its destinations.
 *
 * Nothing here decides whether something changed; that was settled before an event existed.
 */

/**
 * Whether an event is a debut on a board the scoreboard did not have before this collection.
 *
 * A board appearing is one fact, not ten debuts: Arena opened image-to-code on 2026-09-13 with fifty
 * models on it, seven of them in a top ten nobody had entered, because there was no board to enter
 * before.
 */
export function onNewBoard(stream: string, old: readonly { body: string }[]): (event: Event) => boolean {
  if (stream !== "leaderboards") return () => false;
  const categoryOf = (body: string) => (JSON.parse(body) as { category?: unknown }).category;
  // Read on the first debut rather than up front: most collections have none, and the roster it
  // would parse is every row the board holds.
  let boardsBefore: Set<unknown> | null = null;
  return (event) => {
    if (event.kind !== "new") return false;
    boardsBefore ??= new Set(old.map((row) => categoryOf(row.body)));
    return !boardsBefore.has(categoryOf(event.after_json ?? "{}"));
  };
}

function urlInBody(body: string | null, fallback: string): string {
  if (!body) return fallback;
  try {
    const record = JSON.parse(body) as Record<string, unknown>;
    return typeof record.url === "string" && record.url.trim() ? record.url : fallback;
  } catch {
    return fallback;
  }
}

function eventUrl(event: Event, fallback: string): string {
  // The earlier body is read only when the later one names no address: most events carry both.
  return urlInBody(event.after_json, "") || urlInBody(event.before_json, fallback);
}

/**
 * How long a stealth launch waits for its other venues.
 *
 * Space Bunny reached OpenCode Go and Zen two seconds apart on 2026-09-23, so a couple of minutes
 * is all the venues that matter need to agree, and being early is the whole point of watching
 * them. What a longer wait was really buying -- the context and the modalities, which OpenCode's
 * own row does not carry -- the card now borrows from the catalogues that already hold the model,
 * so there is nothing left to wait for.
 */
const STEALTH_HOLD_MS = 2 * 60_000;

type Pace = "now" | "held" | "hourly";

/** When an event is told: at once, after the stealth hold, or in the next hour's digest. */
export function paceOf(event: Event): Pace {
  if (isRoutine(event)) return "hourly";
  return isStealthLaunch(event) ? "held" : "now";
}

/** The first instant a batch of this pace may be sent. */
export function readyAt(pace: Pace, now: string): string {
  if (pace === "hourly") return new Date((Math.floor(Date.parse(now) / 3_600_000) + 1) * 3_600_000).toISOString();
  return pace === "held" ? new Date(Date.parse(now) + STEALTH_HOLD_MS).toISOString() : now;
}

/** An event that has been given its class; `classifyEmitted` is what makes every emitted one this. */
type Classified = Event & { signal: SignalClass };

/**
 * Gives every emitted event its class and its verdict.
 *
 * Every record is saved by now, so a rule asking what the catalogues list sees this collection too.
 *
 * `speaks` is written in the same pass for the same reason the class is: the store has the event in
 * hand and has to decide anyway, and a reader that asks the question again has to read the body
 * back to answer it -- 105 MB of a floor that is never given back for one report, measured on a
 * copy of production. It is the verdict that was acted on, which is what a report about what this
 * service did should be counting, rather than what today's rules would say about last week's event.
 */
export function classifyEmitted(db: Database, emitted: Event[]): Classified[] {
  for (const event of emitted) {
    event.signal = classify(db, event);
    db.query("UPDATE events SET signal=?,speaks=? WHERE id=?").run(
      event.signal,
      hasNotificationContent(event) ? 1 : 0,
      event.id,
    );
  }
  return emitted as Classified[];
}

/** Puts each emitted event into the batch it will be told in, for every destination that wants its class. */
export function routeEmitted(
  db: Database,
  c: Collection,
  destinations: Destination[],
  emitted: Classified[],
  now: string,
  onANewBoard: (event: Event) => boolean,
): void {
  // Each event is sorted into its pace once; the three batches below are then written in the same
  // order as before, so their ids do not move.
  const byPace: Record<Pace, Classified[]> = { now: [], held: [], hourly: [] };
  for (const event of emitted) if (!onANewBoard(event)) byPace[paceOf(event)].push(event);
  for (const pace of ["now", "held", "hourly"] as const) {
    const digest = pace === "hourly";
    const events = byPace[pace];
    const present = new Set(events.map((event) => event.signal));
    const targets = destinations.filter((destination) => destination.signals.some((signal) => present.has(signal)));
    if (!events.length || !targets.length) continue;
    const ready = readyAt(pace, now);
    const batchSource = digest ? "story-digest" : c.source;
    const existing = digest
      ? db
          .query<{ id: number }, [string, string]>(
            "SELECT id FROM batches WHERE source=? AND digest=1 AND ready_at=? AND sealed=0",
          )
          .get(batchSource, ready)
      : null;
    const batch =
      existing ??
      db
        .query<{ id: number }, [string, number, string]>(
          "INSERT INTO batches(source,digest,ready_at) VALUES(?,?,?) RETURNING id",
        )
        .get(batchSource, Number(digest), ready);
    if (!batch) throw storageFailure("an event batch");
    for (const event of events)
      db.query("INSERT INTO batch_events(batch_id,event_id,url,signal) VALUES(?,?,?,?)").run(
        batch.id,
        event.id,
        eventUrl(event, c.url),
        event.signal,
      );
    for (const destination of targets)
      db.query("INSERT OR IGNORE INTO batch_targets(batch_id,destination_id,destination_json) VALUES(?,?,?)").run(
        batch.id,
        destination.id,
        JSON.stringify(destination),
      );
  }
}
