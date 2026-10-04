import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { pointers } from "../reports/pointers.js";
import { count, type OperationMap } from "./definition.js";

/**
 * The one command in "evidence" that answers about a catalogue rather than about an event.
 *
 * Everything beside it reads the trail this service detected -- events, stories, the verdicts on
 * them. This reads what two catalogues say right now: where each `-latest` pointer aims, and which
 * listings carry a date they stop being served. Both are state rather than history, which is why
 * the window is only for the moves.
 */
export function pointerOperations(db: Database, _config: AppConfig): OperationMap {
  return {
    pointers: {
      section: "evidence",
      summary:
        "Where every moving `-latest` pointer aims, which of them moved, and which listings are dated to stop being served.",
      startHere: "what does a caller who asked for no version get now",
      note:
        "A pointer moving is the only thing a catalogue does that changes what an unchanged line of " +
        "somebody's code is served, and it reaches no channel: no pointer has moved in the retained " +
        "catalogue bodies, so a card for it would be a class and a channel chosen for something nobody " +
        "has seen. It is asked for here instead. `targetListedHere: false` is the answer worth " +
        "watching -- a pointer aiming at a name no catalogue here has recorded is a model that exists " +
        "before it is announced -- and `expiring` is a venue's own hosting window, which " +
        "`lifecycle-deadlines` holds with no reminders and no card. `firstRead` is separate from " +
        "`moves` on purpose: eighteen pointers gained the field in one minute when this service began " +
        "storing it, and that is this deployment starting to look rather than a maker switching anything.",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(365, 30) }),
      cli: { args: [{ name: "days", optional: true }] },
      http: { method: "get", path: "/api/pointers" },
      handler: (input: { days: number }) => pointers(db, input.days),
    },
  };
}
