import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { storageReport } from "../reports/storage.js";
import { count, type OperationMap } from "./definition.js";

/**
 * What the database file is made of, in the "health" section beside `memory`.
 *
 * Its own file because the section it belongs to is already as long as the ratchet allows, and
 * because it is the one entry there that is about disk rather than about a running process.
 */
export function storageOperations(db: Database, _config: AppConfig): OperationMap {
  return {
    storage: {
      section: "health",
      summary:
        "What the database file is made of: payload bytes by table, the sources behind the stored payloads, and how fast events grow.",
      startHere: "the database is growing, or the size alert fired, and I need to know what it is made of",
      note:
        "`bodies` is what the large columns weigh, largest first; snapshots are counted as stored, which " +
        "is gzipped. `unaccountedBytes` is the file less those and the free pages -- indexes, every " +
        "smaller table and page overhead -- so it is a remainder, not a measurement. `snapshots.bySource` " +
        "is where to look before widening retention: it lists the sources holding the most stored " +
        "payload and the share they hold, and a row with `keptRows` far below `rows` is retention " +
        "working. `events.pace` extrapolates the complete days of the window; events are never deleted, " +
        "so it is the only growth here that has no ceiling, and it is an average rather than a forecast. " +
        "Row counts are `schema`; this is bytes.",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(90, 14), top: count(50, 10) }),
      cli: {
        args: [
          { name: "days", optional: true },
          { name: "top", optional: true },
        ],
      },
      http: { method: "get", path: "/api/storage" },
      handler: (input: { days: number; top: number }) => storageReport(db, input),
    },
  };
}
