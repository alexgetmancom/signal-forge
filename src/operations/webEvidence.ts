import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { narrowStoredWebEvidence } from "../storage/webEvidence.js";
import { count, type OperationMap } from "./definition.js";

/**
 * The repair that narrows web change events stored before the write path narrowed them.
 *
 * Its own file because `storage` is already as long as the ratchet allows, and because this is the
 * one entry there that rewrites rows rather than reading or reclaiming them.
 */
export function webEvidenceOperations(db: Database, _config: AppConfig): OperationMap {
  return {
    narrow_web_evidence: {
      section: "host",
      summary:
        "Rewrite stored web change events to the strings that changed, dropping the unchanged table around them.",
      startHere: "`storage` shows the events table dominated by a few web sources, and those rows predate narrowing",
      note:
        "Reads every `web` `changed` event larger than `minBytes` and keeps, on each side, only the " +
        "strings the other side does not have -- which is what every reader of these events already " +
        "computes, so no card changes. `freedBytes` is the JSON given back, measured per row; the pages " +
        "stay inside the file until `compact-storage` returns them. Idempotent: a narrowed row no " +
        "longer exceeds `minBytes`. An event with no `before_json` is a first sighting and is left alone.",
      mutates: true,
      agent: false,
      schema: z.object({ minBytes: count(10_000_000, 4_096), limit: count(100_000, 5_000) }),
      cli: {
        args: [
          { name: "minBytes", optional: true },
          { name: "limit", optional: true },
        ],
      },
      http: { method: "post", path: "/api/events/narrow-web-evidence" },
      handler: (input: { minBytes: number; limit: number }) => narrowStoredWebEvidence(db, input),
    },
  };
}
