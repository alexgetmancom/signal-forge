import type { Database } from "bun:sqlite";
import { ARRIVAL_GROUPS, periodArrivals } from "./recap/arrivals.js";
import { periodBoards } from "./recap/boards.js";
import { periodCodenameCount } from "./recap/codenameCount.js";
import { HEADLINES, periodHeadlines } from "./recap/headlines.js";
import { periodLeaders } from "./recap/leaders.js";
import { periodPriceMoves } from "./recap/priceMoves.js";
import { periodReading, type RecapPeriod } from "./recap/reading.js";
import { periodRetirements } from "./recap/retirements.js";
import { type RecapContext, recapContextSchema } from "./recap/schema.js";
import { periodSightings } from "./recap/sightings.js";

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
/**
 * The same summary over a day, for the invited room. The scouts are told every sighting as it
 * happens and nothing about the numbers that move too little to speak on their own: a price cut,
 * a board changing hands at the top. One message a morning says those, and never pings.
 */

/**
 * One period, as the lines a message is written from.
 *
 * Each line is its own function of the same reading, because the lines are independent of each
 * other and the question "why does the day say this" should be answerable by reading one of them.
 */
export function recapContext(db: Database, to: string, period: RecapPeriod = "week"): RecapContext {
  const reading = periodReading(db, to, period);
  const { arrivals, arrivalCount, arrived } = periodArrivals(reading);
  const { retirements, retirementNotes } = periodRetirements(reading, arrived);
  const { climbers, indexed, newBoards } = periodBoards(reading);
  const { resellerArrivals, codeNotes } = periodSightings(reading);
  return recapContextSchema.parse({
    period,
    codeNotes,
    resellerArrivals,
    headlines: periodHeadlines(reading).slice(0, HEADLINES),
    climbers,
    newBoards: newBoards.slice(0, 3),
    indexed,
    leaders: periodLeaders(reading),
    retirements,
    retirementNotes,
    from: reading.from,
    to,
    arrivals: arrivals.slice(0, ARRIVAL_GROUPS),
    arrivalCount,
    priceMoves: periodPriceMoves(reading),
    codenameCount: periodCodenameCount(reading),
  });
}
