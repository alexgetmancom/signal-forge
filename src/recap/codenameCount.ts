import { modelSubject } from "../events/variants.js";
import { nameOf, type PeriodReading } from "./reading.js";

/** Where a thing shows up before anyone announces it. */
const EARLY_STREAMS = new Set(["arena", "pages"]);

/**
 * What the scouts actually saw early: something unannounced showing up where it should not be yet.
 *
 * Distinct subjects, not events: the arena and the leaderboards are re-read all week, and counting
 * every observation turns "the scouts saw ten things early" into five figures. A model taking a
 * place on one more scoreboard is a `codename` by class and is not that.
 */
export function periodCodenameCount(reading: PeriodReading): number {
  return new Set(
    reading.classified
      .filter(
        ({ event, signal }) =>
          signal === "codename" && EARLY_STREAMS.has(event.stream) && !event.source.startsWith("discovery:"),
      )
      .map(({ event }) => modelSubject(nameOf(event))),
  ).size;
}
