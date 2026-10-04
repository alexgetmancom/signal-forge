import type { Database } from "bun:sqlite";

import { PROMPT_VERSION, worthCutoffs } from "../jev.js";

/**
 * Where Jev and the routing rules disagree, with the rule that decided each case.
 *
 * Jev reads events all day and nothing downstream listens: its worth decides how many lines a
 * morning recap gets and nothing else. Measured over the week to 2026-09-23 the two do not merely
 * differ, they run against each other -- of nine events judged 2.5 or better none was delivered,
 * while the 42 judged 0 produced eleven cards, the highest rate of any band. One of the two readers
 * is wrong, and this is the list that says which, one event at a time.
 *
 * `heldBack` is what Jev rated highly and a rule stopped, named by the rule, and those are the
 * candidates for a rule that is too blunt. `spoke` is what reached a reader with a low judgement,
 * and those are the candidates for filler. Only judgements at the current prompt version count,
 * because a worth is a property of the question that was asked.
 */
export type JudgeGap = {
  cutoffs: { story: number; commit: number };
  /** Every disagreement in the window counted, whatever `limit` left room to list. */
  streams: StreamGap[];
  /** Every held-back disagreement counted by the rule that made it, stream by stream. */
  reasons: ReasonGap[];
  heldBack: GapRow[];
  spoke: GapRow[];
};

type StreamGap = { stream: string; judged: number; heldBack: number; spoke: number };

/** `?1` the window's start, `?2` the story cutoff, `?3` the commit cutoff, `?4` the row limit. */
type Window = [since: string, story: number, commit: number, limit: number];

/** The prefix of it a statement that stops at `?3` or `?2` binds: SQLite counts what it was given. */
type Counted = [since: string, story: number, commit: number];

type ReasonGap = { stream: string; reason: string; heldBack: number };

type GapRow = {
  eventId: number;
  source: string;
  stream: string;
  entity: string;
  worth: number;
  kind: string;
  detectedAt: string;
  /** The suppression reason, for a held-back event. */
  reason?: string;
};

/**
 * Every statement here is numbered `?1` the window, `?2` the story cutoff, `?3` the commit cutoff,
 * `?4` the limit, and binds all four whether it uses them or not.
 *
 * The fragments below are shared between four statements that use different subsets of the four in
 * different textual orders, and a `?` binds by where it appears: moving a `CASE WHEN` inside a
 * SELECT list silently re-pairs the arguments with it. Numbering them makes a fragment mean the
 * same thing everywhere it is pasted. Named parameters would too, and cost more: they bind only on
 * a database opened `strict`, and `openReadonly` is not one, so `probe` and `rehearse` got a
 * mis-bound query that answered zero rows rather than an error.
 */
const OF_JUDGEMENT = `JOIN event_evaluations v ON v.event_id=e.id AND v.evaluator='jev'
    AND v.prompt_version='${PROMPT_VERSION}'`;

/** Every judgement of the current prompt version in the window, with the event it is of. */
const JUDGED = `FROM events e ${OF_JUDGEMENT} WHERE e.detected_at>=?1`;

/** The same, one row per suppression, so the rule that held an event back can be grouped on. */
const JUDGED_BY_REASON = `FROM events e ${OF_JUDGEMENT}
    JOIN suppressions s ON s.event_id=e.id WHERE e.detected_at>=?1`;

const SELECT = `SELECT e.id eventId, e.source, e.stream, e.entity_id entity, e.detected_at detectedAt,
    v.worth, v.kind ${JUDGED}`;

const DELIVERED = "EXISTS (SELECT 1 FROM delivery_events x WHERE x.event_id=e.id)";

const SUPPRESSED = "EXISTS (SELECT 1 FROM suppressions s WHERE s.event_id=e.id)";

const HELD_BACK = `v.worth>=?2 AND NOT ${DELIVERED} AND ${SUPPRESSED}`;

/**
 * The same two disagreements as counts rather than as rows.
 *
 * `heldBack` and `spoke` are lists with a `limit` on them, and a limit is the wrong instrument for
 * "which stream is this happening in": the fourteen-day question hit the ceiling at 200 and the
 * answer to it was arithmetic on a truncated list. These count the window itself, so the shape of
 * the disagreement does not depend on how much of it was asked to be printed, and `judged` says
 * what each stream's two numbers are a share of.
 */
function gapCounts(db: Database, ...window: Window): { streams: StreamGap[]; reasons: ReasonGap[] } {
  // A statement binds up to the highest number it mentions and no further: the stream counts reach
  // `?3`, the reason counts stop at `?2`.
  const [since, story, commit] = window;
  const streams = db
    .query<StreamGap, Counted>(
      `SELECT e.stream, COUNT(*) judged,
         COALESCE(SUM(CASE WHEN ${HELD_BACK} THEN 1 END),0) heldBack,
         COALESCE(SUM(CASE WHEN v.worth<?3 AND ${DELIVERED} THEN 1 END),0) spoke
       ${JUDGED} GROUP BY e.stream ORDER BY heldBack DESC, spoke DESC, judged DESC`,
    )
    .all(since, story, commit);
  const reasons = db
    .query<ReasonGap, [since: string, story: number]>(
      `SELECT e.stream, s.reason, COUNT(DISTINCT e.id) heldBack
       ${JUDGED_BY_REASON} AND v.worth>=?2 AND NOT ${DELIVERED}
       GROUP BY e.stream, s.reason ORDER BY heldBack DESC, e.stream, s.reason`,
    )
    .all(since, story);
  return { streams, reasons };
}

export function judgeGap(db: Database, days: number, limit: number, now = new Date()): JudgeGap {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const cutoffs = worthCutoffs(db, now);
  const window: Window = [since, cutoffs.story, cutoffs.commit, limit];
  const heldBack = db
    .query<GapRow & { reason: string }, Window>(
      `${SELECT} AND ${HELD_BACK}
       ORDER BY v.worth DESC, e.id DESC LIMIT ?4`,
    )
    .all(...window)
    .map((row) => ({
      ...row,
      reason:
        db
          .query<{ reason: string }, [number]>("SELECT reason FROM suppressions WHERE event_id=? LIMIT 1")
          .get(row.eventId)?.reason ?? "",
    }));
  const spoke = db
    .query<GapRow, Window>(
      `${SELECT} AND v.worth<?3 AND ${DELIVERED}
       ORDER BY v.worth ASC, e.id DESC LIMIT ?4`,
    )
    .all(...window);
  return { cutoffs, ...gapCounts(db, ...window), heldBack, spoke };
}
