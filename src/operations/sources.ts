import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { openCredentialCircuits } from "../credentials.js";
import { channelMix } from "../reports/channelMix.js";
import { coverageGaps } from "../reports/coverageGaps.js";
import { leadTime } from "../reports/leadTime.js";
import { passedOver } from "../reports/passedOver.js";
import { signalQuality } from "../reports/signalQuality.js";
import { sourceVerdicts } from "../reports/sourceVerdicts.js";
import { deepSeekUsage } from "../runtime/deepseekUsage.js";
import { codeAnalytics } from "../runtime/metrics.js";
import { count, type OperationMap } from "./definition.js";

/** The "sources" section of the operation registry; src/operations.ts joins the sections. */
export function sourcesOperations(db: Database, config: AppConfig, _all: () => OperationMap): OperationMap {
  return {
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
