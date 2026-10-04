import type { Database } from "bun:sqlite";
import { batchViewOf, standingAnswers } from "../events/standing.js";
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
 */
export type Why = {
  event: {
    id: number;
    source: string;
    stream: string;
    entityId: string;
    kind: string;
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
    heldBy: string | null;
    answers: { check: string; reason: string | null; fromTheBatch: boolean }[];
  };
  /**
   * What a replay of one event cannot reproduce, named rather than silently wrong.
   *
   * Four of the standing questions are about an event's siblings -- a field that arrived on the
   * whole list, a change that reached three records at once, a branch of pages published in one
   * read. Replayed alone the event has no siblings, so those answer no. The batch it was actually
   * in is gone; the stored half above is what speaks for it.
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
  // The view a batch of one builds: everything that is a function of the event alone is faithful,
  // and everything that is not is listed in `cannotBeReplayed` rather than reported as a pass.
  const answers = standingAnswers(db, row, batchViewOf(db, [row]));
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
      heldBy: answers.find((answer) => answer.reason)?.reason ?? null,
      answers,
    },
    cannotBeReplayed: answers.filter((answer) => answer.fromTheBatch).map((answer) => answer.check),
  };
}
