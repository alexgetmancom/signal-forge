import type { Database } from "bun:sqlite";
import { worthCutoffs } from "../insights.js";
import { PROMPT_VERSION } from "../jev.js";

/**
 * Whether a reader agrees with Jev, by the only ground truth there is: the thumbs.
 *
 * `judge-gap` says where Jev and the routing rules disagree, and it cannot say which of the two is
 * right -- both are readers of an event and neither is the reader. This asks the question the other
 * way round. A card went out, somebody left a thumb on it, and Jev had already scored the events
 * inside it: so the score has an outcome beside it, and a score with an outcome is the only thing
 * that can be called calibration rather than a second opinion.
 *
 * Deliberately thin, and says so. Over the sixty days to 2026-10-04 the whole newsroom had 78 voted
 * cards across three rooms, which is twenty per band and decides nothing on its own -- `reactions`
 * has said as much since it was written. The point of shipping the instrument at this size is that
 * it accumulates: a band's favour rate is comparable with the same band's rate next month, where an
 * argument about whether to trust Jev more is not comparable with the one that came before it.
 *
 * `voted` against `delivered` is the number to read first. It is how much of a band was voted on at
 * all, and until it stops being a tenth, everything to the right of it is an anecdote with a
 * denominator attached.
 */
export type JudgeCalibration = {
  days: number;
  /** The thresholds the routing rules use, so a band can be read against the line that matters. */
  cutoffs: { story: number; commit: number };
  promptVersion: string;
  bands: WorthBand[];
  /** Delivered cards in the window whose events carry no judgement at this prompt version. */
  unjudgedCards: number;
};

type WorthBand = {
  /** The half-open interval of Jev's score, as `[from, to)`. */
  from: number;
  to: number;
  /** Cards delivered in the window whose best-judged event falls in this band. */
  delivered: number;
  /**
   * Of those, the ones carrying at least one thumb. The denominator of everything after it.
   *
   * A row in `scout_reactions` exists for every card a reader opened, with counts that are usually
   * zero, so this is not the row count: it is the cards somebody actually reacted to.
   */
  voted: number;
  favour: number;
  against: number;
  /** 👍 as a share of all thumbs in the band, or null when nobody voted in it. */
  favourRate: number | null;
};

/**
 * A card is banded by the best score among the events it carries, because that is what a reader is
 * reacting to: a digest of twenty names is as good as the best thing in it, and scoring it by the
 * mean would put every digest in the bottom band whatever it led with.
 */
const BEST_WORTH = `(SELECT MAX(v.worth) FROM delivery_events de
     JOIN event_evaluations v ON v.event_id=de.event_id AND v.evaluator='jev' AND v.prompt_version=?2
    WHERE de.delivery_id=d.id)`;

/** The bands Jev's own scale is read in: its four criteria are "not at all" through "must know". */
const EDGES = [0, 1, 2, 3, 4] as const;

type Row = { worth: number | null; votes: number | null; against: number | null };

export function judgeCalibration(db: Database, days = 60, now = Date.now()): JudgeCalibration {
  const since = new Date(now - days * 24 * 3_600_000).toISOString();
  // One row per delivery, never per event inside it: the fan-out through `delivery_events` is what
  // read 42 votes against where 14 cards had been voted on, and `readerVotes` says why.
  const rows = db
    .query<Row, [string, string]>(
      `SELECT ${BEST_WORTH} worth, r.votes, r.against
         FROM deliveries d LEFT JOIN scout_reactions r ON r.delivery_id = d.id
        WHERE d.status='sent' AND d.updated_at >= ?1`,
    )
    .all(since, PROMPT_VERSION);
  const bands: WorthBand[] = [];
  for (const [index, from] of EDGES.slice(0, -1).entries()) {
    const to = EDGES[index + 1] as number;
    // The top band is closed, so a score of exactly 4 is in it rather than in nothing.
    const mine = rows.filter((row) => row.worth !== null && row.worth >= from && (row.worth < to || to === 4));
    // A row in `scout_reactions` is a card that was read, not a card that was voted on: the reader
    // reads every message and leaves a thumb on few, so the zero rows are the silence and counting
    // them as votes read 87 voted cards where there were 25.
    const voted = mine.filter((row) => (row.votes ?? 0) + (row.against ?? 0) > 0);
    const favour = voted.reduce((sum, row) => sum + (row.votes ?? 0), 0);
    const against = voted.reduce((sum, row) => sum + (row.against ?? 0), 0);
    bands.push({
      from,
      to,
      delivered: mine.length,
      voted: voted.length,
      favour,
      against,
      favourRate: favour + against ? Number((favour / (favour + against)).toFixed(2)) : null,
    });
  }
  return {
    days,
    cutoffs: worthCutoffs(db, new Date(now)),
    promptVersion: PROMPT_VERSION,
    bands,
    unjudgedCards: rows.filter((row) => row.worth === null).length,
  };
}
