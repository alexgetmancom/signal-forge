import type { Database } from "bun:sqlite";
import { signalOf } from "../events/classify.js";
import { renamedEvents } from "../events/rename.js";
import type { SignalClass } from "../events/signals.js";
import type { Event, RecordData } from "../events/types.js";
import { usageRanks, witnessedSubjects } from "../events/witness.js";

/**
 * Which destinations a period's recap goes to, by the classes they carry. A day is two things for
 * two rooms: price moves are `change`, read by the public wire as news of what they pay; a board
 * changing hands at the top is read by the scouts beside their sightings. A destination gets the
 * part of the day its classes ask for, and nothing when that part is empty.
 */
export const PERIODS = {
  // `untold`: only moves no card carried. A week is what moved furthest, told or not; a day is the
  // moves too small for a card of their own, and says so in its footer.
  week: { source: "weekly-recap", ms: 7 * 24 * 3_600_000, signals: ["launch"], untold: false, feature: "weekly-recap" },
  // Off since 2026-09-26, and now off in `featureEnabled` rather than by an empty list of classes:
  // the classes say who would read it, and emptying them made a retired feature look like a broken
  // one. `features` is where its state is read. The morning list was built from what is easy to count rather than
  // from what the room could not find out by itself: over 24, 25 and 26 September it spent eleven of
  // its seventeen lines on one catalogue restating models it had already listed, on a six-week-old
  // image model and on a roleplaying model, and its three scored lines each named an effort variant
  // whose number was below the one this database already held for the model -- GLM-5.3 at 34.3 when
  // (max) had been 44.9 here since 19 September. A room told the wrong number is worse served than a
  // room told nothing. Kept for the reports, and `recapContext(db, to, "day")` still answers.
  day: { source: "daily-recap", ms: 24 * 3_600_000, signals: ["codename"], untold: true, feature: "daily-recap" },
  // What the labs published in a day, for the wire: a partnership, an essay, a research result is
  // the vendor talking rather than a model changing, so it is never a card of its own, and on
  // 2026-09-16 "Mistral X Mozilla" and "Claude Cowork and chat are now one Claude" reached nobody.
  // One morning list of headlines carries them without making the wire louder.
  // Off since 2026-09-22: to a reader on a $20 plan a day of lab posts was filler, and to the
  // scouts, who came to hear first, it is what everyone already published. Kept for the reports.
  news: { source: "daily-news", ms: 24 * 3_600_000, signals: ["launch"], untold: true, feature: "daily-news" },
} as const;
export type RecapPeriod = keyof typeof PERIODS;

/**
 * The end of the most recent complete week, as an instant.
 *
 * Sunday evening UTC: late enough that a week's last day is over in the Americas, early enough that
 * Asia reads it on Monday morning rather than a day later.
 */
export function lastRecapPeriod(now: number, period: RecapPeriod = "week"): string {
  const end = new Date(now);
  // The day closes at 06:00 UTC, which is the start of the morning in Moscow and the evening before
  // on the American west coast: the room reads it with coffee rather than at midnight.
  end.setUTCHours(period === "week" ? 18 : 6, 0, 0, 0);
  while ((period === "week" && end.getUTCDay() !== 0) || end.getTime() > now) end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString();
}

export function recordOf(event: Event): RecordData | null {
  const body = event.after_json ?? event.before_json;
  return body ? (JSON.parse(body) as RecordData) : null;
}

export function nameOf(event: Event): string {
  return String(recordOf(event)?.name ?? event.entity_id);
}

/**
 * Everything a period is read from, read once.
 *
 * Every line of a recap is a different question about the same window, and each of them needs some
 * of the same five readings: what happened in it, which of those events were renames, which models
 * anything else has ever seen, what people actually run, and what already went out as a card. They
 * are gathered here so that each line below is a function of the window rather than of a hundred
 * lines of setup above it.
 */
export type PeriodReading = {
  db: Database;
  period: RecapPeriod;
  from: string;
  to: string;
  classified: { event: Event; signal: SignalClass }[];
  renamed: Set<number>;
  witnessed: Set<string>;
  usage: Map<string, number>;
  /** Events a card already carried, for the periods whose lines are only what was never told. */
  carded: Set<number>;
};

export function periodReading(db: Database, to: string, period: RecapPeriod): PeriodReading {
  const from = new Date(Date.parse(to) - PERIODS[period].ms).toISOString();
  const events = db
    .query<Event, [string, string]>("SELECT * FROM events WHERE detected_at>=? AND detected_at<? ORDER BY id")
    .all(from, to);
  const classified = events.map((event) => ({ event, signal: signalOf(event) }));
  const renamed = renamedEvents(db, events);
  const witnessed = witnessedSubjects(db);
  const usage = usageRanks(db);
  // On 2026-09-18 the morning recap repeated GLM 5.2, Kimi K3 and gpt-oss-120b from cards sent
  // hours before.
  const carded = new Set(
    !PERIODS[period].untold
      ? []
      : db
          .query<{ event_id: number }, [string, string]>(
            `SELECT DISTINCT de.event_id FROM delivery_events de JOIN deliveries d ON d.id=de.delivery_id
         JOIN events e ON e.id=de.event_id
         WHERE d.status IN ('pending','sending','sent','ambiguous','verification_required')
           AND e.detected_at>=? AND e.detected_at<?`,
          )
          .all(from, to)
          .map((row) => row.event_id),
  );
  return { db, period, from, to, classified, renamed, witnessed, usage, carded };
}
