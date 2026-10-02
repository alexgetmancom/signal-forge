import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { mentionSource } from "../sources/modelMentions.js";
import { buildSourceRegistry } from "../sources/registry.js";
import { nearest, type OperationMap } from "./definition.js";

/**
 * The two commands that settle a source rather than report on one, in the "sources" section.
 *
 * Apart from the reports because they are the only entries there that write, and because a reader
 * looking for either of them is looking for a stuck source, not for a weekly figure. Both are
 * `agent: false`: one re-reads a repository and can deliver, the other spends a judgement about the
 * outside world, and neither is a question.
 */
export function sourceSettlementOperations(db: Database, config: AppConfig): OperationMap {
  return {
    rescan_repository: {
      section: "sources",
      summary: "Forget where a watched repository was read to, so its next poll reads the whole tree again.",
      note:
        "For a repository subscribed to before the first read scanned its tree: the names already " +
        "sitting in it were never reported, and nothing will add them again. Reports only names no " +
        "catalogue holds, so a repository full of shipped models stays quiet.",
      mutates: true,
      // A poll that re-reads a repository can deliver, which is routine work, but the operator asks for it.
      agent: false,
      schema: z.object({ repo: z.string().min(3) }),
      cli: { args: [{ name: "repo", rest: true }] },
      handler: (input: { repo: string }) => {
        const source = mentionSource(input.repo);
        const removed = db.query("DELETE FROM records WHERE source=? AND id='@head'").run(source).changes;
        if (!removed) throw new Error(`${input.repo} is not a watched repository, or has never been read`);
        return { repo: input.repo, source, message: "The next poll of this repository reads its tree in full" };
      },
    },
    accept_shrink: {
      section: "sources",
      summary:
        "Accept that a catalogue is genuinely smaller now, so its next collection is stored however far it shrank.",
      startHere: 'a source is stuck on "collection degraded"',
      note:
        "The guard refuses an answer that lost a quarter of a source's rows, because a partial " +
        "answer reads as a mass removal and the rows come back on the next poll. When the loss is " +
        "real the guard never clears by itself: arena.ai stopped publishing its anonymous models " +
        "and the source has been frozen against 1083 rows it will never serve again. Check the " +
        "live page before spending this -- it is spent on the next collection, whatever it holds.",
      mutates: true,
      // Accepting a mass removal is a judgement about the outside world, which is the operator's.
      agent: false,
      schema: z.object({ source: z.string().min(2) }),
      cli: { args: [{ name: "source" }] },
      handler: (input: { source: string }) => {
        mustBeCollected(db, config, input.source);
        db.query(
          "UPDATE sources SET accept_shrink=1,failures=0,retry_at=NULL,failure_started_at=NULL,last_error=NULL WHERE id=?",
        ).run(input.source);
        return {
          source: input.source,
          message: "The next collection of this source is stored at whatever size it comes back, once",
        };
      },
    },
  };
}

/**
 * A source id that has never been collected, answered with the ones that could be.
 *
 * The names come from the registry rather than from the table: `sources` keeps a row for every
 * source that ever ran, and offering a retired one as a suggestion is offering a name that will
 * fail differently.
 */
function mustBeCollected(db: Database, config: AppConfig, source: string): void {
  if (db.query("SELECT 1 FROM sources WHERE id=?").get(source)) return;
  const known = buildSourceRegistry(db, config).map((definition) => definition.id);
  throw new Error(`${source} is not a source that has ever been collected. ${nearest(source, known)}`);
}
