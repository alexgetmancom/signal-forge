import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig, Destination } from "./config.js";
import { priceMoveRatio } from "./events/render/common.js";
import { signalClass } from "./events/signals.js";
import type { Event, RecordData } from "./events/types.js";

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

function nameOf(event: Event): string {
  const body = event.after_json ?? event.before_json;
  const record = body ? (JSON.parse(body) as RecordData) : null;
  return String(record?.name ?? event.entity_id);
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
  const arrivals = classified
    .filter(({ event, signal }) => signal === "launch" && event.kind === "new")
    .map(({ event }) => nameOf(event));
  const priceMoves = classified
    .filter(({ signal }) => signal === "change")
    .flatMap(({ event }) => {
      const move = steepestMove(event);
      return move ? [{ name: nameOf(event), percent: move.percent, cheaper: move.cheaper }] : [];
    })
    .sort((one, other) => other.percent - one.percent)
    .slice(0, 3);
  return weeklyRecapContextSchema.parse({
    from,
    to,
    arrivals: [...new Set(arrivals)].slice(0, 8),
    arrivalCount: new Set(arrivals).size,
    priceMoves,
    codenameCount: classified.filter(({ signal }) => signal === "codename").length,
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
