import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { unknownMakers } from "../reports/unknownMakers.js";
import { count, type OperationMap } from "./definition.js";

/**
 * The part of the "sources" section that is about the vendor table rather than the collectors.
 *
 * Its own file because `sourcesOperations` is at its recorded size budget, and because the question
 * is a different one: every other entry in that section asks whether a collector is working, and
 * this asks whether what the working collectors brought back can be attributed to anybody.
 */
export function vendorTableOperations(db: Database, _config: AppConfig): OperationMap {
  return {
    unknown_makers: {
      section: "sources",
      summary:
        "Model handles the catalogues listed that no pattern in the vendor table places, ranked by how many independent sources named them; the top rows are the ones to add to VENDORS.",
      startHere: "which makers are we dropping on the floor",
      note: "A handle no pattern matches is either a laboratory worth following or somebody's checkpoint, and the count of independent sources is what tells them apart. Unknown is not cosmetic: those models carry no maker on their cards and join no vendor's story.",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(90, 30), limit: count(200, 40) }),
      cli: {
        args: [
          { name: "days", optional: true },
          { name: "limit", optional: true },
        ],
      },
      http: { method: "get", path: "/api/unknown-makers" },
      handler: (input: { days: number; limit: number }) => unknownMakers(db, input.days, input.limit),
    },
  };
}
