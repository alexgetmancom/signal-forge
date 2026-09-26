import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { featureReport } from "../reports/features.js";
import type { OperationMap } from "./definition.js";

/**
 * The "features" question, which belongs to the health section and to its own file: what this
 * deployment has been told to do, and whether anyone is reading it. src/features.ts is the list.
 */
export function featureOperations(db: Database, config: AppConfig): OperationMap {
  return {
    features: {
      section: "health",
      summary: "Everything this deployment can be told to stop doing, whether it is doing it, and when it last did.",
      startHere: "what is switched on here, and is anything on that nobody reads",
      note:
        "Read-only, and read before a revision rather than during an incident. Three states, and the " +
        "difference between them is the point: `off` is a decision recorded in `featureEnabled`, " +
        "`unavailable` is a credential or a channel the config does not have, and `on` says nothing " +
        "about whether anyone is listening -- that is what `lastActivity` and `quietDays` are for. A " +
        "feature that is on and has been quiet for weeks is the list to revise; `activity` names the " +
        "trace each timestamp was read from, and is null where nothing in the database belongs to that " +
        "feature alone. Collectors are not features: they have their own switch and `capabilities` " +
        "reports them. Turning one on or off is an edit to `featureEnabled` in signal-forge.json on the " +
        "host, so it survives a deploy.",
      mutates: false,
      agent: true,
      schema: z.object({}),
      cli: {},
      http: { method: "get", path: "/api/features" },
      handler: () => featureReport(db, config),
    },
  };
}
