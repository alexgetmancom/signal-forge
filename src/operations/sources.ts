import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { openCredentialCircuits } from "../credentials.js";
import { channelMix } from "../reports/channelMix.js";
import { coverageGaps } from "../reports/coverageGaps.js";
import { judgeGap } from "../reports/judgeGap.js";
import { leadTime } from "../reports/leadTime.js";
import { passedOver } from "../reports/passedOver.js";
import { releaseAudit } from "../reports/releaseAudit.js";
import { signalQuality } from "../reports/signalQuality.js";
import { silentSources } from "../reports/silentSources.js";
import { sourceVerdicts } from "../reports/sourceVerdicts.js";
import { deepSeekUsage } from "../runtime/deepseekUsage.js";
import { codeAnalytics } from "../runtime/metrics.js";
import { mentionSource } from "../sources/modelMentions.js";
import { count, type OperationMap } from "./definition.js";

/** The "sources" section of the operation registry; src/operations.ts joins the sections. */
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
        const known = db.query("SELECT 1 FROM sources WHERE id=?").get(input.source);
        if (!known) throw new Error(`${input.source} is not a source that has ever been collected`);
        db.query(
          "UPDATE sources SET accept_shrink=1,failures=0,retry_at=NULL,failure_started_at=NULL,last_error=NULL WHERE id=?",
        ).run(input.source);
        return {
          source: input.source,
          message: "The next collection of this source is stored at whatever size it comes back, once",
        };
      },
    },
    silent_sources: {
      section: "sources",
      summary:
        "Enabled sources that have neither collected nor recorded anything lately, with the error each one carries.",
      startHere: "which sources went quiet without anyone noticing",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(90, 3) }),
      cli: { args: [{ name: "days", optional: true }] },
      http: { method: "get", path: "/api/silent-sources" },
      handler: (input: { days: number }) => silentSources(db, config, input.days),
    },
    judge_gap: {
      section: "sources",
      summary: "Events Jev rated highly that a rule held back, and low-rated events that reached a reader.",
      startHere: "do the routing rules and the classifier agree",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(90, 7), limit: count(200, 25) }),
      cli: {
        args: [
          { name: "days", optional: true },
          { name: "limit", optional: true },
        ],
      },
      http: { method: "get", path: "/api/judge-gap" },
      handler: (input: { days: number; limit: number }) => judgeGap(db, input.days, input.limit),
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
    passed_over: {
      section: "sources",
      summary:
        "Subjects ranked by how many unrelated sources recorded them, and whether a reader ever heard: the misses, with the rules that made each one.",
      startHere: "what did we know about before anyone was told",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(90, 7), limit: count(200, 50) }),
      cli: {
        args: [
          { name: "days", optional: true },
          { name: "limit", optional: true },
        ],
      },
      http: { method: "get", path: "/api/passed-over" },
      handler: (input: { days: number; limit: number }) => passedOver(db, input.days, input.limit),
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
    channel_mix: {
      section: "sources",
      summary:
        "What each destination actually carried: signal classes delivered or unrouted, lead-time share and promotions.",
      startHere: "what the public channel is really full of",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(90, 7) }),
      cli: { args: [{ name: "days", optional: true }] },
      http: { method: "get", path: "/api/channel-mix" },
      handler: (input: { days: number }) => channelMix(db, config, input.days),
    },
    signal_quality: {
      section: "sources",
      summary: "Source collection, event, delivery and suppression metrics for an operator-selected period.",
      startHere: "is a source earning its place in the feed",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(90, 7) }),
      cli: { args: [{ name: "days", optional: true }] },
      http: { method: "get", path: "/api/signal-quality" },
      handler: (input: { days: number }) => signalQuality(db, config, input.days),
    },
    code_analytics: {
      section: "sources",
      summary: "Execution frequency, duration and failure analytics for instrumented runtime sections.",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(90, 7) }),
      cli: { args: [{ name: "days", optional: true }] },
      http: { method: "get", path: "/api/code-analytics" },
      handler: (input: { days: number }) => codeAnalytics(db, input.days),
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
