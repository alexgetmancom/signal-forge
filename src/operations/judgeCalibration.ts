import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { judgeCalibration } from "../reports/judgeCalibration.js";
import { judgeModality } from "../reports/judgeModality.js";
import { count, type OperationMap } from "./definition.js";

/**
 * Its own file for the reason `vendorTable.ts` is one: `calibrationOperations` is at the size the
 * gate stops at. The question is a different one anyway. Everything else in that file measures the
 * rules against each other or a model against the rules; this measures a model against the one
 * reader whose opinion is not another judgement.
 */
export function judgeCalibrationOperations(db: Database, _config: AppConfig): OperationMap {
  return {
    judge_calibration: {
      section: "sources",
      summary:
        "Jev's score banded against the thumbs the cards in each band got: the only number that says whether to trust it more.",
      startHere: "is the classifier right about what a reader wants",
      note:
        "`judge-gap` says where Jev and the rules disagree and cannot say which is right, because " +
        "both are readers of an event and neither is the reader. This has an outcome beside the " +
        "score, which is what makes it calibration rather than a third opinion. Read `voted` " +
        "against `delivered` first: it is how much of a band anyone reacted to at all, and while " +
        "that is a tenth, everything to the right of it is an anecdote with a denominator attached " +
        "-- 78 voted cards in sixty days across three rooms when this shipped. The instrument is " +
        "here at that size because it accumulates and an argument does not. A card is banded by the " +
        "best score among its events, because a digest of twenty names is as good as the thing it " +
        "leads with and banding by the mean would put every digest at the bottom. One card is one " +
        "vote, as everywhere else. `unjudgedCards` carries no judgement at the current prompt " +
        "version at all, and it is the whole window for a day after a version bump.",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(365, 60) }),
      cli: { args: [{ name: "days", optional: true }] },
      http: { method: "get", path: "/api/judge-calibration" },
      handler: (input: { days: number }) => judgeCalibration(db, input.days),
    },
    judge_modality: {
      section: "sources",
      summary: "What the rules read off a model's name against what Jev says the model makes, counted.",
      startHere: "is a name enough to tell a picture model from a coding one",
      note:
        "Shadow only: Jev has been asked what a model produces since prompt version 6 and nothing " +
        "acts on the answer. Read the two disagreements separately, because they do not cost the " +
        "same. `missedByTheRules` is a name with no modality word in it that Jev calls a picture, " +
        "a sound or an embedding -- the case that puts a card in front of a reader who did not " +
        "come for it, which `models/gemini-nano-banana-2.1` did on 2026-10-06. " +
        "`calledByTheRulesOnly` is the opposite: a word in a name that Jev does not read as the " +
        "model's job, which sends to the radar something that could have been a card, and is the " +
        "cheaper mistake because a reader's thumb can promote it. `notComparable` is every " +
        "judgement with no modality on it: all of them, for a day after the version bump, until " +
        "`bun run backfill-judgements` has run. Neither column is ground truth; the boards a model " +
        "is measured on are, and this is the evidence for going to look at them.",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(365, 30), limit: count(200, 20) }),
      cli: {
        args: [
          { name: "days", optional: true },
          { name: "limit", optional: true },
        ],
      },
      http: { method: "get", path: "/api/judge-modality" },
      handler: (input: { days: number; limit: number }) => judgeModality(db, input.days, input.limit),
    },
  };
}
