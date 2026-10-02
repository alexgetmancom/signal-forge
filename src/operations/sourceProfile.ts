import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { knownSourceIds, sourceProfile } from "../reports/sourceProfile.js";
import { count, nearest, type OperationMap } from "./definition.js";

/**
 * The one command that answers about a single source, in the "sources" section.
 *
 * Apart from the reports beside it because every one of them reads all two hundred sources and this
 * reads one, and because it is the only entry there keyed by a name rather than by a window. The
 * rest of `sources` is how the collectors are doing; this is what one of them is.
 */
export function sourceProfileOperations(db: Database, config: AppConfig): OperationMap {
  return {
    source: {
      section: "sources",
      summary: "Everything known about one source: what it declares, how it is doing, and what it has produced.",
      startHere: "I have a source name and want to know what it is, whether it works, and what it ever said",
      note:
        "The registry's declaration, the row `sources` keeps, the records it holds now, its events, its " +
        "latest collections, its newest payload and how many cards built from it were sent -- the " +
        "answers of six commands for one name instead of two hundred. A retired source answers too: " +
        "`registered: false` with a `retiredAt` is a collector taken out on purpose whose history is " +
        "still here, which no other command offers. `waitingOn` names the credential a registered " +
        "source is idle for. `days` is the window for events, collection attempts and sent cards. " +
        "It carries counts and instants, never an upstream value; `failures <source>` has the " +
        "structure of a refusal and `snapshot <source>` the payload.",
      mutates: false,
      agent: true,
      schema: z.object({ source: z.string().min(1), days: count(90, 30) }),
      cli: { args: [{ name: "source" }, { name: "days", optional: true }] },
      http: {
        method: "get",
        path: "/api/sources/*",
        // A source id carries slashes and colons (`npm:@openai/codex`), so it is the rest of the
        // path rather than one segment, as a canonical model id is.
        input: (request) => {
          const prefix = "/api/sources/";
          const raw = request.path.startsWith(prefix) ? request.path.slice(prefix.length) : "";
          try {
            return { source: decodeURIComponent(raw), days: request.query.days };
          } catch {
            return { source: "", days: request.query.days };
          }
        },
      },
      handler: (input: { source: string; days: number }) => {
        const profile = sourceProfile(db, config, input.source, input.days);
        if (!profile)
          throw new Error(
            `${input.source} is not a source this deployment has ever collected. ${nearest(input.source, knownSourceIds(db, config))}`,
          );
        return profile;
      },
    },
  };
}
