import type { Database } from "bun:sqlite";
import { worthCutoffs } from "../insights.js";
import { PROMPT_VERSION } from "../jev.js";

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
  heldBack: GapRow[];
  spoke: GapRow[];
};

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

const SELECT = `SELECT e.id eventId, e.source, e.stream, e.entity_id entity, e.detected_at detectedAt,
    v.worth, v.kind FROM events e JOIN event_evaluations v ON v.event_id=e.id AND v.evaluator='jev'
    AND v.prompt_version='${PROMPT_VERSION}'
  WHERE e.detected_at>=?`;

const DELIVERED = "EXISTS (SELECT 1 FROM delivery_events x WHERE x.event_id=e.id)";

export function judgeGap(db: Database, days: number, limit: number, now = new Date()): JudgeGap {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const cutoffs = worthCutoffs(db, now);
  const heldBack = db
    .query<GapRow & { reason: string }, [string, number, number]>(
      `${SELECT} AND v.worth>=? AND NOT ${DELIVERED}
         AND EXISTS (SELECT 1 FROM suppressions s WHERE s.event_id=e.id)
       ORDER BY v.worth DESC, e.id DESC LIMIT ?`,
    )
    .all(since, cutoffs.story, limit)
    .map((row) => ({
      ...row,
      reason:
        db
          .query<{ reason: string }, [number]>("SELECT reason FROM suppressions WHERE event_id=? LIMIT 1")
          .get(row.eventId)?.reason ?? "",
    }));
  const spoke = db
    .query<GapRow, [string, number, number]>(
      `${SELECT} AND v.worth<? AND ${DELIVERED}
       ORDER BY v.worth ASC, e.id DESC LIMIT ?`,
    )
    .all(since, cutoffs.commit, limit);
  return { cutoffs, heldBack, spoke };
}
