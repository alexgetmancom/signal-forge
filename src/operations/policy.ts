import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { lateArrivals } from "../reports/lateArrivals.js";
import { why } from "../reports/why.js";
import { count, identifier, type OperationMap } from "./definition.js";

/**
 * The two questions about the routing policy itself, rather than about what it decided.
 *
 * Their own file because they are one question at two scales and they answer each other. `why`
 * takes an event and says which rule spoke; `late-arrivals` takes a week and says which cards the
 * rules should have stopped and did not, with the event ids to put back into `why`. They sit in
 * different sections -- one is evidence about a claim, the other is a reading of the sources -- and
 * that is where an operator looks for each, so the registry keeps them apart and this file keeps
 * them together.
 */
export function policyOperations(db: Database, _config: AppConfig): OperationMap {
  return {
    why: {
      section: "evidence",
      summary:
        "Every standing rule asked of one event, in the order they are asked, with what each answered and which one decided -- beside what the stored decision actually was.",
      startHere: "a card went out that should not have, or did not go out and should have",
      note: "`event <id>` is the other half and the one to read first: it holds the before/after evidence, the batches and the deliveries -- what the claim rests on. This holds only the policy: which questions were put to the event and how each answered. They are reported together because they can disagree, and the disagreement is the finding -- `stored` is the decision made by the code running that day, `replay` is what the rules in this deployment say now, so a rule shipped since shows up as exactly that gap. `cannotBeReplayed` names the questions that read the event's siblings: replayed alone it has none, so those answer no whatever the batch did, and the stored half is what speaks for them. Reach for it before `rehearse`, which wants a copy of production to answer what changed between two trees rather than what the rules say about one event.",
      mutates: false,
      agent: true,
      schema: z.object({ id: identifier }),
      cli: { args: [{ name: "id" }] },
      http: { method: "get", path: "/api/why/:id" },
      notFoundWhenEmpty: true,
      handler: (input: { id: number }) => why(db, input.id),
    },
    late_arrivals: {
      section: "sources",
      summary:
        "Of the model sightings that reached a channel, how old their own publisher already said they were: the ones sent late, worst first, and the sources they came from.",
      startHere: "did we just announce a back catalogue as news",
      note: "The inverse of `release-audit`, and the one that catches a mistake rather than measuring a success: that report starts from the models released in the window, so a model published two years ago cannot appear in it, which is the exact shape of the failure this is for. Read `deliveredLate` against `heldLate` -- late sightings held is the rule working, late sightings sent is the rule having a gap -- and read `bySource` before the rows, because a widened listing, a new organisation or a collector that started reading a back catalogue all show up as a cluster under one source. `why <event-id>` says which rule let each row through.",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(90, 7), limit: count(200, 50) }),
      cli: {
        args: [
          { name: "days", optional: true },
          { name: "limit", optional: true },
        ],
      },
      http: { method: "get", path: "/api/late-arrivals" },
      handler: (input: { days: number; limit: number }) => lateArrivals(db, input.days, input.limit),
    },
  };
}
