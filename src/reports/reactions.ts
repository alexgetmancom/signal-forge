import type { Database } from "bun:sqlite";

/**
 * What the channel has actually voted on, by source and by the kind of card.
 *
 * The thumbs are the only measurement here that comes from the people the newsroom is written for
 * rather than from a rule about what they might want, and until `readersVote` they were recorded
 * and never read back. That vote is deliberately arithmetic: with nineteen in favour and four
 * against across the whole newsroom, anything cleverer would be fitting a curve to noise, and
 * feeding it to Jev as calibration would teach a judge that noise is a preference.
 *
 * So this report exists to let that decision be made later on evidence instead of on appetite. It
 * shows the tallies as they stand, per source and per signal class, so the question "is there
 * enough here yet" has an answer that is looked up rather than guessed. `enoughToCalibrate` is the
 * threshold named in advance, for the same reason: a bar moved after seeing the data is not a bar.
 */
type ReactionTally = {
  key: string;
  cards: number;
  favour: number;
  against: number;
};

export type ReactionReport = {
  since: string;
  destinations: ReactionTally[];
  sources: ReactionTally[];
  signals: ReactionTally[];
  /** Votes against, newsroom-wide, and whether there are yet enough to calibrate a judge on. */
  against: number;
  enoughToCalibrate: boolean;
};

/** Named before the data was looked at: below this, a preference is indistinguishable from a mood. */
const CALIBRATION_FLOOR = 40;

export function reactionStandings(db: Database, days = 60, now = Date.now()): ReactionReport {
  const since = new Date(now - days * 24 * 3_600_000).toISOString();
  const tally = (column: string): ReactionTally[] =>
    db
      .query<ReactionTally, [string]>(
        `SELECT ${column} key, COUNT(*) cards, COALESCE(SUM(r.votes),0) favour, COALESCE(SUM(r.against),0) against
           FROM scout_reactions r
           JOIN delivery_events de ON de.delivery_id = r.delivery_id
           JOIN deliveries d ON d.id = r.delivery_id
           JOIN events e ON e.id = de.event_id
          WHERE e.detected_at >= ? AND (r.votes > 0 OR r.against > 0)
          GROUP BY 1 ORDER BY against DESC, favour DESC`,
      )
      .all(since);
  const sources = tally("e.source");
  const against = sources.reduce((total, row) => total + row.against, 0);
  return {
    since,
    destinations: tally("d.destination_id"),
    sources,
    signals: tally("COALESCE(NULLIF(e.signal,''),'unclassified')"),
    against,
    enoughToCalibrate: against >= CALIBRATION_FLOOR,
  };
}
