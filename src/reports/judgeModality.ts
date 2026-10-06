import type { Database } from "bun:sqlite";

import { isAJobThisReaderDidNotComeFor } from "../events/subject.js";
import type { Event } from "../events/types.js";
import { PROMPT_VERSION } from "../jev.js";

/**
 * What the rules read off a name against what Jev read off the row, and nothing else.
 *
 * The routing question "did this reader come for this job" is answered today by a regular
 * expression over the source, the id and the name (`isAJobThisReaderDidNotComeFor`). A name need
 * not carry the word: `models/gemini-nano-banana-2.1` is an image model that reached the news
 * channel on 2026-10-06, and the list was extended by hand afterwards. Jev is asked the same thing
 * from prompt version 6 and its answer is stored, acting on nothing.
 *
 * This counts the two readings against each other so the decision to trust one is made on a number.
 * It cannot say which is right -- that is `judge-gap`'s limitation and it is this one's too -- but
 * the two disagreements are not symmetric, and it separates them: `missedByTheRules` is a name with
 * no modality word that Jev calls a picture, which is the case that reaches a reader it was not
 * meant for, and `calledByTheRulesOnly` is a word in a name Jev does not read as the model's job,
 * which is a sighting sent to the radar that could have been a card.
 */
export type JudgeModality = {
  days: number;
  promptVersion: string;
  /** Judgements with no modality to compare: asked before version 6, or answered `other`. */
  notComparable: number;
  /** Judgements where the two readings are the same, split by what they agreed on. */
  agreed: { text: number; otherModality: number };
  /**
   * How many each disagreement happened, beside the examples. The lists are cut to `limit`, and a
   * list of twenty that is actually two hundred reads as the smaller problem.
   */
  disagreed: { missedByTheRules: number; calledByTheRulesOnly: number };
  missedByTheRules: Disagreement[];
  calledByTheRulesOnly: Disagreement[];
};

type Disagreement = {
  eventId: number;
  source: string;
  stream: string;
  entity: string;
  /** What Jev answered: `text`, `image`, `video`, `audio`, `embedding`, `not_a_model`, `other`. */
  modality: string;
  /** What the rules called the event, kept on the judgement when it was stored. */
  rules: string;
};

/**
 * The three strings the name reading needs and nothing else. Whole bodies are not selected here --
 * `check-sql` refuses it, for the reason that this read would then cost what the archive has grown
 * to -- so the record the predicate takes is assembled from the two keys it looks at.
 */
type Row = {
  id: number;
  source: string;
  stream: string;
  entity_id: string;
  name: string | null;
  recordId: string | null;
  modality: string | null;
  rules: string;
};

export function judgeModality(db: Database, days = 30, limit = 20, now = new Date()): JudgeModality {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const rows = db
    .query<Row, [string, string]>(
      `SELECT e.id, e.source, e.stream, e.entity_id, v.modality, v.rules,
              json_extract(e.after_json,'$.name') name, json_extract(e.after_json,'$.id') recordId
         FROM event_evaluations v JOIN events e ON e.id = v.event_id
        WHERE v.evaluator='jev' AND v.prompt_version=?2 AND v.evaluated_at>=?1
        ORDER BY e.id DESC`,
    )
    .all(since, PROMPT_VERSION);
  const report: JudgeModality = {
    days,
    promptVersion: PROMPT_VERSION,
    notComparable: 0,
    agreed: { text: 0, otherModality: 0 },
    disagreed: { missedByTheRules: 0, calledByTheRulesOnly: 0 },
    missedByTheRules: [],
    calledByTheRulesOnly: [],
  };
  for (const row of rows) {
    // `other` is Jev declining to answer, and a row that is not about a model has no modality to
    // compare: neither is evidence about a name, and counting them as text would invent agreement.
    if (!row.modality || row.modality === "other" || row.modality === "not_a_model") {
      report.notComparable += 1;
      continue;
    }
    const byName = isAJobThisReaderDidNotComeFor(row as unknown as Event, {
      id: row.recordId ?? "",
      name: row.name ?? "",
    });
    const byJev = row.modality !== "text";
    if (byName === byJev) {
      report.agreed[byJev ? "otherModality" : "text"] += 1;
      continue;
    }
    report.disagreed[byJev ? "missedByTheRules" : "calledByTheRulesOnly"] += 1;
    const into = byJev ? report.missedByTheRules : report.calledByTheRulesOnly;
    if (into.length < limit)
      into.push({
        eventId: row.id,
        source: row.source,
        stream: row.stream,
        entity: row.entity_id,
        modality: row.modality,
        rules: row.rules,
      });
  }
  return report;
}
