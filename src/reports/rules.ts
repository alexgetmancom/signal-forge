import type { AppConfig } from "../config.js";
import { classifyRuleNames } from "../events/classify.js";
import { classRuleNames } from "../events/signals.js";
import { standingCheckNames } from "../events/standing.js";
import { SUPPRESSION_DETAIL, SUPPRESSION_REASONS } from "../events/suppression.js";

/**
 * Every rule that decides what a reader is told, named, in the order it is asked.
 *
 * The answer to "where are the delivery rules" used to be four files and a reading of them, and
 * the cost of that was not abstract. Eleven v4 Turbo went to both public channels on 2026-10-05
 * and `prod why` printed twenty-nine standing rules, all silent, because the deciding layer had no
 * names to print. `cohere/embed-v5.0-fast` went to the radar because two questions were asked in
 * the wrong order, and the whole bug was an order nobody could see. Both layers have names now,
 * and this is the one place that reads them all out.
 *
 * Generated from the lists themselves, never a second copy of them: a rule added anywhere above
 * appears here on the next call, and one deleted disappears. That is the only property that makes
 * a document about rules worth reading at all.
 */
export type Rules = {
  /**
   * The layers, in the order an event passes through them. Each says what it is allowed to read,
   * because that is what decides which questions can live in it: the first knows only the event,
   * so it cannot ask what else the database has seen, and the third knows the batch, so replaying
   * one event alone cannot answer it.
   */
  layers: { layer: string; reads: string; livesIn: string; decides: string; rules: string[] }[];
  /** Who is told what: a destination subscribes to classes, which is the whole of its taste. */
  destinations: { destination: string; signals: string[] }[];
  /** Every reason a card can be held, with the sentence a reader of the suppression row sees. */
  reasons: { reason: string; detail: string }[];
};

export function rules(config: AppConfig): Rules {
  return {
    layers: [
      {
        layer: "the event alone",
        reads: "the event and the record it carries",
        livesIn: "src/events/signals.ts",
        decides: "the class, which is what a destination subscribes to",
        rules: classRuleNames(),
      },
      {
        layer: "the event and the database",
        reads: "everything collected before it",
        livesIn: "src/events/classify.ts",
        decides: "the class it is stored with, which the reports read back",
        rules: classifyRuleNames(),
      },
      {
        layer: "the standing judgement",
        reads: "the event, its batch and the history",
        livesIn: "src/events/standing.ts",
        decides: "whether it is worth telling anyone, whoever they are",
        rules: standingCheckNames(),
      },
      {
        layer: "one event, one destination",
        reads: "what this destination has already been told",
        livesIn: "src/events/batchPolicy.ts",
        decides: "whether this channel hears it now",
        rules: ["subscribed_to_the_class", "already_told_this_destination", "past_the_digest_limit"],
      },
    ],
    destinations: config.destinations.map((destination) => ({
      destination: destination.id,
      signals: [...destination.signals],
    })),
    reasons: SUPPRESSION_REASONS.map((reason) => ({ reason, detail: SUPPRESSION_DETAIL[reason] })),
  };
}
