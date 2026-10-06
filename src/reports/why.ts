import type { Database } from "bun:sqlite";
import { classifyDecision } from "../events/classify.js";
import { asTheRulesSeeThem, theBatchItWasIn } from "../events/replayPolicy.js";
import { classDecision } from "../events/signals.js";
import { standingAnswers } from "../events/standing.js";
import type { Event } from "../events/types.js";

/**
 * Why one event did or did not become a card, rule by rule.
 *
 * `suppressions` answers this for an event that was held: the row carries the reason that stopped
 * it. Nothing answered it for an event that spoke, and that is the half every investigation needs,
 * because the question a channel asks is always "why did this go out". Until this existed the only
 * way to see the rules that passed was `bun run rehearse`, which wants a copy of production and
 * four gigabytes to say what a replay of one event says in a second -- and it answers a different
 * question anyway: what *changed* between two trees, not what the rules say now.
 *
 * Both halves are reported because they can disagree, and the disagreement is the finding. The
 * stored decision is what actually happened, under the code that was running that day; the replay
 * is what the rules in this deployment say today. A rule shipped since then shows up as exactly
 * that gap, which is how you tell "we fixed it" from "it never applied".
 *
 * The replay is built through `asTheRulesSeeThem` and `theBatchItWasIn` rather than by hand, which
 * is the whole reason both of those are named: the first version of this file read `events.signal`
 * out of the row and judged a batch of one, so it answered the five class-dependent questions
 * wrongly on every event stored before that column was written, and reported the four
 * batch-dependent ones as unanswerable when the batch was sitting in `batch_events`.
 */
export type Why = {
  event: {
    id: number;
    source: string;
    stream: string;
    entityId: string;
    kind: string;
    /** The class stored on the row, which is null for anything older than the column. */
    signal: string | null;
    detectedAt: string;
  };
  /** What actually happened to it: the rows, not a replay of them. */
  stored: {
    batched: boolean;
    delivered: boolean;
    /** One per destination that was told nothing, with the rule that stopped it. */
    heldBy: { destination: string; reason: string; detail: string; recordedAt: string }[];
  };
  /**
   * The standing questions as they stand today, in the order they are asked, with the first one
   * that holds the event marked. Reported whole rather than cut at the deciding rule: a reader
   * tightening a rule needs to know what would have caught the event next if it had not.
   */
  replay: {
    /** The class the rules give it now, which is what the questions were actually asked about. */
    signal: string;
    /**
     * The class question that decided it, named. The layer no reason used to come from: Eleven v4
     * Turbo was answered here and the twenty-nine standing rules below all read as silent, which
     * from outside looks like no rule having an opinion rather than one having spoken earlier.
     */
    classRule: string;
    /**
     * The database-dependent question that then changed it, or null when none did. The two are
     * reported apart because they can only be read apart: the first is a function of the event, so
     * it answers the same way forever, and the second asks what else had been collected by then.
     */
    classifiedBy: string | null;
    /** The siblings the batch-dependent questions were asked against, and where they came from. */
    batch: { size: number; reconstructed: boolean };
    heldBy: string | null;
    answers: { check: string; reason: string | null; fromTheBatch: boolean }[];
  };
  /**
   * What this replay could not reproduce, named rather than silently answered no.
   *
   * Empty for an event whose batch was found, which is almost all of them. An event that never
   * reached a batch has no siblings to find, so the four questions about siblings are listed here
   * instead of reported as passes; the stored half above is what speaks for it.
   */
  cannotBeReplayed: string[];
};

type Row = Event & { batched: number; delivered: number };

export function why(db: Database, eventId: number): Why | null {
  const row = db
    .query<Row, [number]>(
      `SELECT e.*,
              EXISTS(SELECT 1 FROM batch_events be WHERE be.event_id=e.id) AS batched,
              EXISTS(SELECT 1 FROM batch_events be JOIN deliveries d ON d.batch_id=be.batch_id
                     WHERE be.event_id=e.id AND d.status='sent') AS delivered
         FROM events e WHERE e.id=?`,
    )
    .get(eventId);
  if (!row) return null;
  const held = db
    .query<{ destination_id: string; reason: string; detail: string; recorded_at: string }, [number]>(
      "SELECT destination_id,reason,detail,recorded_at FROM suppressions WHERE event_id=? ORDER BY destination_id",
    )
    .all(eventId);
  const batch = theBatchItWasIn(db, row);
  const { events, view } = asTheRulesSeeThem(db, batch.events);
  // The classed copy of this event, not the row: the questions must be asked of what the view was
  // built from, or the event and its own batch disagree about what it is.
  const self = events.find((event) => event.id === row.id) ?? events[0];
  if (!self) return null;
  const answers = standingAnswers(db, self, view);
  return {
    event: {
      id: row.id,
      source: row.source,
      stream: row.stream,
      entityId: row.entity_id,
      kind: row.kind,
      signal: row.signal ?? null,
      detectedAt: row.detected_at,
    },
    stored: {
      batched: Boolean(row.batched),
      delivered: Boolean(row.delivered),
      heldBy: held.map((one) => ({
        destination: one.destination_id,
        reason: one.reason,
        detail: one.detail,
        recordedAt: one.recorded_at,
      })),
    },
    replay: {
      signal: self.signal,
      classRule: classDecision(self).rule,
      classifiedBy: classifyDecision(db, self).rule,
      batch: { size: events.length, reconstructed: batch.reconstructed },
      heldBy: answers.find((answer) => answer.reason)?.reason ?? null,
      answers,
    },
    cannotBeReplayed: batch.reconstructed
      ? []
      : answers.filter((answer) => answer.fromTheBatch).map((answer) => answer.check),
  };
}
