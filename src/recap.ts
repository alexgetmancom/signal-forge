import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig, Destination } from "./config.js";
import { priceMoveRatio } from "./events/render/common.js";
import { signalClass } from "./events/signals.js";
import type { Event, RecordData } from "./events/types.js";
import { arrivalWeight, displayName, isModelVariant, isRepublished, modelSubject } from "./events/variants.js";
import { vendorOfName } from "./events/vendors.js";

/**
 * A week, summarised once, in the channel that otherwise only says what is happening now.
 *
 * The public wire is built for the moment a thing happens, which is exactly what a reader who was
 * away cannot use: scrolling back through a week of cards is not a summary of it. One message says
 * what arrived, what moved furthest and what the scouts saw before anyone else, and it is worth the
 * most in the quiet weeks -- the ones where a reader would otherwise wonder why they follow this.
 *
 * It is a batch like any other, so it is rendered, delivered and retried by the machinery that
 * already exists, and its identity is the period it covers: one row per week per source, enforced
 * by an index rather than remembered by this function.
 */
const RECAP_SOURCE = "weekly-recap";
const WEEK_MS = 7 * 24 * 3_600_000;
/** Where a thing shows up before anyone announces it. */
const EARLY_STREAMS = new Set(["arena", "pages"]);

export const weeklyRecapContextSchema = z.object({
  from: z.string(),
  to: z.string(),
  arrivals: z.array(z.string()),
  arrivalCount: z.number(),
  priceMoves: z.array(z.object({ name: z.string(), percent: z.number(), cheaper: z.boolean() })),
  codenameCount: z.number(),
  bestLead: z.object({ name: z.string(), hours: z.number() }).nullable(),
});
export type WeeklyRecapContext = z.infer<typeof weeklyRecapContextSchema>;

/**
 * The end of the most recent complete week, as an instant.
 *
 * Sunday evening UTC: late enough that a week's last day is over in the Americas, early enough that
 * Asia reads it on Monday morning rather than a day later.
 */
export function lastRecapPeriod(now: number): string {
  const end = new Date(now);
  end.setUTCHours(18, 0, 0, 0);
  while (end.getUTCDay() !== 0 || end.getTime() > now) end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString();
}

function recordOf(event: Event): RecordData | null {
  const body = event.after_json ?? event.before_json;
  return body ? (JSON.parse(body) as RecordData) : null;
}

function nameOf(event: Event): string {
  return String(recordOf(event)?.name ?? event.entity_id);
}

/**
 * Is this arrival a model, or another way of listing one?
 *
 * A batch tier, a free tier, a `latest` alias, a dated snapshot and somebody else's quantisation
 * are all real records and none of them is a release. Counting them is how the first recap reported
 * thirty-seven models in a week that had nine, and led with a batch tier of a model from July.
 */
function isRealArrival(event: Event): boolean {
  const record = recordOf(event);
  return !isModelVariant(String(record?.name ?? event.entity_id)) && !isRepublished(event, record);
}

function steepestMove(event: Event): { percent: number; cheaper: boolean } | null {
  const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  const from = before?.pricing && typeof before.pricing === "object" ? (before.pricing as Record<string, unknown>) : {};
  const to = after?.pricing && typeof after.pricing === "object" ? (after.pricing as Record<string, unknown>) : {};
  let best: { percent: number; cheaper: boolean } | null = null;
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    const ratio = priceMoveRatio(from[key], to[key], event.source);
    if (ratio === null || ratio === 0) continue;
    const cheaper = Number(to[key]) < Number(from[key]);
    if (!best || ratio > best.percent) best = { percent: ratio, cheaper };
  }
  return best;
}

export function weeklyRecapContext(db: Database, to: string): WeeklyRecapContext {
  const from = new Date(Date.parse(to) - WEEK_MS).toISOString();
  const events = db
    .query<Event, [string, string]>("SELECT * FROM events WHERE detected_at>=? AND detected_at<? ORDER BY id")
    .all(from, to);
  const classified = events.map((event) => ({ event, signal: signalClass(event) }));
  // One model however many collectors saw it, and the maker's own word ahead of a reseller's.
  const bySubject = new Map<string, { name: string; weight: number }>();
  for (const { event, signal } of classified) {
    if (signal !== "launch" || event.kind !== "new" || !isRealArrival(event)) continue;
    const weight = arrivalWeight(event);
    const held = bySubject.get(modelSubject(nameOf(event)));
    if (!held || weight > held.weight) bySubject.set(modelSubject(nameOf(event)), { name: nameOf(event), weight });
  }
  // Weight first, then a maker a reader has heard of: a research artefact published as weights
  // outranks a catalogue row on paper and is not what the week was about.
  const arrivals = [...bySubject.values()]
    .sort(
      (one, other) =>
        other.weight - one.weight ||
        Number(vendorOfName(other.name) !== "Unknown") - Number(vendorOfName(one.name) !== "Unknown"),
    )
    .map((one) => displayName(one.name));
  const priceMoves = classified
    .filter(({ event, signal }) => signal === "change" && !isModelVariant(nameOf(event)))
    .flatMap(({ event }) => {
      const move = steepestMove(event);
      return move ? [{ name: nameOf(event), percent: move.percent, cheaper: move.cheaper }] : [];
    })
    .sort((one, other) => other.percent - one.percent)
    .slice(0, 3);
  return weeklyRecapContextSchema.parse({
    from,
    to,
    arrivals: arrivals.slice(0, 8),
    arrivalCount: arrivals.length,
    priceMoves,
    // Distinct subjects, not events: the arena and the leaderboards are re-read all week, and
    // counting every observation turns "the scouts saw ten things early" into five figures.
    // What the scouts actually saw early: something unannounced showing up where it should not be
    // yet. A model taking a place on one more scoreboard is a `codename` by class and is not that.
    codenameCount: new Set(
      classified
        .filter(
          ({ event, signal }) =>
            signal === "codename" && EARLY_STREAMS.has(event.stream) && !event.source.startsWith("discovery:"),
        )
        .map(({ event }) => modelSubject(nameOf(event))),
    ).size,
    bestLead: null,
  });
}

/**
 * Queue the recap for the week that has just ended, once.
 *
 * It goes to the destinations that carry launches, which is the wire a reader follows for what they
 * can use: the invited room sees every one of these events as it happens and does not need the
 * week read back to it.
 */
export function scheduleWeeklyRecap(db: Database, config: AppConfig, now = Date.now()): boolean {
  const readyAt = lastRecapPeriod(now);
  const targets = (config.destinations as Destination[]).filter((destination) =>
    destination.signals.includes("launch"),
  );
  if (!targets.length) return false;
  const existing = db
    .query<{ id: number }, [string, string]>(
      "SELECT id FROM batches WHERE kind='weekly_recap' AND source=? AND ready_at=?",
    )
    .get(RECAP_SOURCE, readyAt);
  if (existing) return false;
  const context = weeklyRecapContext(db, readyAt);
  // A week in which nothing arrived, nothing moved and nothing was sighted is not worth a message.
  if (!context.arrivalCount && !context.priceMoves.length && !context.codenameCount) return false;
  const batch = db
    .query<{ id: number }, [string, string, string]>(
      "INSERT INTO batches(source,digest,ready_at,kind,context_json) VALUES(?,0,?,'weekly_recap',?) RETURNING id",
    )
    .get(RECAP_SOURCE, readyAt, JSON.stringify(context));
  if (!batch) throw new Error("Weekly recap batch insert failed");
  for (const destination of targets)
    db.query("INSERT INTO batch_targets(batch_id,destination_id,destination_json) VALUES(?,?,?)").run(
      batch.id,
      destination.id,
      JSON.stringify(destination),
    );
  return true;
}
