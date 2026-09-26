import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { openCredentialCircuits } from "../credentials.js";
import { coverageGaps } from "../reports/coverageGaps.js";
import { leadTime } from "../reports/leadTime.js";
import { releaseAudit } from "../reports/releaseAudit.js";
import { silentSources } from "../reports/silentSources.js";
import { sourceKinds } from "../reports/sourceKinds.js";
import { sourceVerdicts } from "../reports/sourceVerdicts.js";
import { deepSeekUsage } from "../runtime/deepseekUsage.js";
import { mentionSource } from "../sources/modelMentions.js";
import { buildSourceRegistry } from "../sources/registry.js";
import { count, nearest, type OperationMap } from "./definition.js";

/** The "sources" section of the operation registry; src/operations.ts joins the sections. */
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

export function sourcesOperations(db: Database, config: AppConfig, _all: () => OperationMap): OperationMap {
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
    source_kinds: {
      section: "sources",
      summary: "What the registered sources are made of by kind, and which families no kind names yet.",
      startHere: "how sources are organised, and where adding one is still copy and paste",
      note:
        "A kind, in src/sources/kinds.ts, says once what a family of sources shares and why its " +
        "pace is what it is, so a member is one row that cannot forget a field. `unnamed_families` " +
        "is the debt: sources sharing an authority, a group and a stream that no kind names. " +
        "Nothing there is broken, and most of it is already generated from a list -- but the pace " +
        "has no reason written beside it, and the next entry copied into it inherits whatever the " +
        "one above it got wrong. The test holds `unnamed` as a ratchet, so it can only go down.",
      mutates: false,
      agent: true,
      schema: z.object({}),
      cli: {},
      http: { method: "get", path: "/api/source-kinds" },
      handler: () => sourceKinds(db, config),
    },
    silent_sources: {
      section: "sources",
      summary:
        "Enabled sources that have neither collected nor recorded anything lately, with the error each one carries.",
      startHere: "which sources went quiet without anyone noticing",
      note:
        "`state` is the repair, and two of the three are not the collector. `went_quiet` worked and " +
        "then stopped, which is a collector to open. `never_succeeded` was asked and has never once " +
        "worked, which is usually a credential or an upstream refusing. `never_polled` was never " +
        "asked at all, so nothing here is evidence about its collector: `reason` says which " +
        "capability it is waiting on, and when it says it is waiting on nothing, that is the " +
        "scheduler and it is the only one of the three that is a bug.",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(90, 3) }),
      cli: { args: [{ name: "days", optional: true }] },
      http: { method: "get", path: "/api/silent-sources" },
      handler: (input: { days: number }) => silentSources(db, config, input.days),
    },
    lead_time: {
      section: "sources",
      summary: "Which sources saw a story first, and by how long, over an operator-selected period.",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(90, 7) }),
      cli: { args: [{ name: "days", optional: true }] },
      http: { method: "get", path: "/api/lead-time" },
      handler: (input: { days: number }) => leadTime(db, input.days),
    },
    source_verdicts: {
      section: "sources",
      summary:
        "Which enabled sources led another source, reached a reader, drew scout votes or were corroborated by another source while routing held them back; young sources shown as preliminary.",
      startHere: "is a source worth keeping at all",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(90, 30) }),
      cli: { args: [{ name: "days", optional: true }] },
      http: { method: "get", path: "/api/source-verdicts" },
      handler: (input: { days: number }) => sourceVerdicts(db, config, input.days),
    },
    coverage_gaps: {
      section: "sources",
      summary:
        "Front-page Hacker News stories about a followed vendor that no other source recorded; candidates for a missing source, read weekly.",
      startHere: "what did the field talk about that we never saw",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(30, 7) }),
      cli: { args: [{ name: "days", optional: true }] },
      http: { method: "get", path: "/api/coverage-gaps" },
      handler: (input: { days: number }) => coverageGaps(db, input.days),
    },
    release_audit: {
      section: "sources",
      summary:
        "Each model released in the window: the source that named it first, the lag behind the model's own created time, and whether a card went out.",
      startHere: "how early did we catch this week's releases",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(30, 7) }),
      cli: { args: [{ name: "days", optional: true }] },
      http: { method: "get", path: "/api/release-audit" },
      handler: (input: { days: number }) => releaseAudit(db, input.days),
    },
    deepseek_usage: {
      section: "sources",
      summary: "DeepSeek Summary attempts, token usage, cache use, cost and code-path breakdown.",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(365, 7) }),
      cli: { args: [{ name: "days", optional: true }] },
      http: { method: "get", path: "/api/deepseek-usage" },
      handler: (input: { days: number }) => deepSeekUsage(db, input.days),
    },
    credential_circuits: {
      section: "sources",
      summary: "Credentials an upstream has refused, and the sources stopped because of them.",
      startHere: "a source stopped collecting and the network looks fine",
      mutates: false,
      agent: true,
      schema: z.object({}),
      cli: {},
      http: { method: "get", path: "/api/credentials" },
      handler: () => openCredentialCircuits(db),
    },
  };
}
