import { finite } from "../finite.js";
import { canonical } from "./canonical.js";
import type { Collection } from "./types.js";

/**
 * Whether a record that is already stored has changed in a way that is an event.
 *
 * Everything here is a pure function of two bodies and the collection's own flags: no database, no
 * clock. It is the part of `persistCollection` that is tuned most often -- a board's own noise, a
 * field that moves on every poll -- and was only reachable through a whole save.
 */

/**
 * A board position is not a property of the model standing in it.
 *
 * A rank moves whenever anyone above moves, so one model passing another moves every model below
 * it and one real change arrives as a change per row: designarena produced 704 change events in
 * eleven days and not one of them carried a score or a metric that had moved. This is the same
 * reason `rankLower` and `rankUpper` were kept out of the metrics sweep in sources/arena.ts.
 *
 * The top of the board is the exception, because it is the only part anything downstream speaks
 * about: `isMinorBoardMove` passes a change that puts something first or takes it off the top, the
 * scouts' morning names big climbs into the top ten, and dithering is read off ranks that keep
 * returning to a place they held. Those all live inside ten. Records are collected down to
 * `RANKED_PLACES`, twenty, and the half of the board below ten is cascade and nothing else: of
 * designarena's 865 change events, 428 never involved a place inside the top ten.
 */
const SIGNIFICANT_PLACES = 10;

function comparable(record: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...record };
  delete copy.sampledAt;
  delete copy.votes;
  const place = finite(copy.rank);
  if (place !== null && place > SIGNIFICANT_PLACES) delete copy.rank;
  return copy;
}

/**
 * Fields that move on every poll and never made a card. Measured on production 2026-09-22 over a
 * week: 332 of 375 Polymarket changes were liquidity alone, 700 of 771 on the Hugging Face router
 * were the list of providers serving a model, 194 of 352 on models.dev its provider count. Each kept
 * its snapshot from being pruned, and the market pages alone held 52 MB. The record still takes the
 * new value; only the event is not written.
 */
const RESTLESS_FIELDS: Readonly<Record<string, readonly string[]>> = {
  markets: ["liquidityUsd"],
  "api-models": ["providers", "providerCount", "created"],
};

/**
 * Verdicts this service stamps onto a record itself, which no source ever published.
 *
 * `audience` is written by the judge in sources/audienceJudge.ts, not by the vendor, and it is
 * already in the NOISE set that keeps it off a card. A verdict arriving late is this service
 * catching up with itself, not the release note changing: 272 of the 275 stored ChatGPT release
 * notes predate the judge, and back-filling them would otherwise write 272 change events about
 * text nobody touched.
 */
const OWN_VERDICTS: readonly string[] = ["audience"];

export function comparisonBody(stream: string, body: string): string {
  const restless = RESTLESS_FIELDS[stream];
  try {
    const record = JSON.parse(body) as Record<string, unknown>;
    if (stream === "leaderboards") return canonical(comparable(record));
    const ignored = [...OWN_VERDICTS, ...(restless ?? [])];
    return canonical(Object.fromEntries(Object.entries(record).filter(([key]) => !ignored.includes(key))));
  } catch {
    return body;
  }
}

/**
 * How far a number may drift before the drift is the news rather than the measurement.
 *
 * A board that publishes a confidence interval says this itself and is believed. A board that
 * publishes none was being compared exactly, because the width fell back to the score and the
 * overlap test became equality: voxelbench and the artificial-analysis boards produced 2688 change
 * events in eleven days, every one of them a score and nothing else. A quarter of a per cent is
 * narrower than any move those boards have ever reported as meaningful.
 */
const IMPLIED_INTERVAL = 0.0025;

function interval(record: Record<string, unknown>): { lower: number; upper: number } | null {
  const score = finite(record.score);
  if (score === null) return null;
  const lower = finite(record.scoreLower);
  const upper = finite(record.scoreUpper);
  if (lower !== null && upper !== null) return { lower, upper };
  const width = Math.abs(score) * IMPLIED_INTERVAL;
  return { lower: score - width, upper: score + width };
}

/**
 * True while every metric the board reports is where it was, within its own width.
 *
 * `metrics` holds whatever numbers the board publishes beside the rating, swept up by name in
 * sources/arena.ts. They drift exactly as the rating does, and comparing them exactly defeated the
 * overlap test beside them: 740 of the arena's 812 change events had a rating whose interval had
 * not moved and a metric that had, in the last digit.
 */
function metricsSettled(previous: Record<string, unknown>, current: Record<string, unknown>): boolean {
  const before = previous.metrics;
  const after = current.metrics;
  const isMetrics = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isMetrics(before) || !isMetrics(after)) return canonical(before) === canonical(after);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = finite(before[key]);
    const now = finite(after[key]);
    if (was === null || now === null) {
      if (canonical(before[key]) !== canonical(after[key])) return false;
      continue;
    }
    if (Math.abs(now - was) > Math.abs(was) * IMPLIED_INTERVAL) return false;
  }
  return true;
}

export function leaderboardChange(before: string, after: string): boolean {
  if (comparisonBody("leaderboards", before) === comparisonBody("leaderboards", after)) return false;
  try {
    const previous = JSON.parse(before) as Record<string, unknown>;
    const current = JSON.parse(after) as Record<string, unknown>;
    const besideTheNumbers = (record: Record<string, unknown>): string => {
      const copy = comparable(record);
      for (const key of ["score", "scoreUpper", "scoreLower", "metrics"]) delete copy[key];
      return canonical(copy);
    };
    const previousInterval = interval(previous);
    const currentInterval = interval(current);
    const intervalsOverlap =
      previousInterval !== null &&
      currentInterval !== null &&
      previousInterval.lower <= currentInterval.upper &&
      currentInterval.lower <= previousInterval.upper;
    if (
      intervalsOverlap &&
      metricsSettled(previous, current) &&
      besideTheNumbers(previous) === besideTheNumbers(current)
    )
      return false;
  } catch {
    return true;
  }
  return true;
}

/**
 * Whether what the answer carries differs from the stored record in a way that is an event.
 *
 * Equal text is answered before anything is parsed: nearly every record of every poll is exactly what
 * it was, and equal text cannot differ under any comparison below, so parsing and canonicalising both
 * sides to learn that was the larger part of a collection's cost.
 */
export function hasMoved(c: Collection, before: string, body: string): boolean {
  if (before === body) return false;
  if (c.appendOnly && !c.trackChanges) return false;
  return c.stream === "leaderboards"
    ? leaderboardChange(before, body)
    : comparisonBody(c.stream, before) !== comparisonBody(c.stream, body);
}
