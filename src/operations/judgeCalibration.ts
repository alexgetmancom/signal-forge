import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { judgeCalibration } from "../reports/judgeCalibration.js";
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
  };
}
