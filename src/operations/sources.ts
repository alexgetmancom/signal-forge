import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { openCredentialCircuits } from "../credentials.js";
import { collectionCost } from "../reports/collectionCost.js";
import { coverageGaps } from "../reports/coverageGaps.js";
import { deepSeekUsage } from "../reports/deepseekUsage.js";
import { leadTime } from "../reports/leadTime.js";
import { pricedUncatalogued } from "../reports/pricedUncatalogued.js";
import { releaseAudit } from "../reports/releaseAudit.js";
import { silentSources } from "../reports/silentSources.js";
import { sourceKinds } from "../reports/sourceKinds.js";
import { sourceVerdicts } from "../reports/sourceVerdicts.js";
import { traffic } from "../reports/traffic.js";
import { METRIC_DAYS } from "../runtime/metricRecording.js";
import { count, type OperationMap } from "./definition.js";

/** The "sources" section of the operation registry; src/operations.ts joins the sections. */
export function sourcesOperations(db: Database, config: AppConfig, _all: () => OperationMap): OperationMap {
  return {
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
    traffic: trafficOperation(db, config),
    collection_cost: {
      section: "sources",
      summary:
        "Child peaks, overlapping collection readings, and peak growth from decoding and persisting answers in the parent.",
      startHere: "which collections and persistence steps coincided with a memory peak",
      note:
        "`childPeakMb` is the whole size a child reached. The parent still reads and persists that " +
        "answer. `addedByDecodeMb` and `addedByPersistenceMb` identify the named source because " +
        "those sections run synchronously; neither vanishes when collection moves into a child. " +
        "`observedDuringCollectionMb` is only an upper bound because concurrent collectors can see " +
        "the same rise, so it cannot justify moving a source into a child. Null means no measurement.",
      mutates: false,
      agent: true,
      // Capped at the metric horizon, not at ninety: the child peaks come from the collection fold,
      // which keeps ninety days, and the parent growth from `code_metrics`, which does not. One cap
      // for the report is what stops its two halves describing different windows.
      schema: z.object({ days: count(METRIC_DAYS, 7) }),
      cli: { args: [{ name: "days", optional: true }] },
      http: { method: "get", path: "/api/collection-cost" },
      handler: (input: { days: number }) => collectionCost(db, config, input.days),
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
        "Which enabled sources led another source, reached a reader, drew scout votes or were corroborated by another source while routing held them back; young sources shown as preliminary. " +
        "Read `appendOnly` beside a `quiet_sentinel`: true is a feed that published nothing, false is a state nobody watched change, and only the second one is ever a bug.",
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
    priced_uncatalogued: {
      section: "sources",
      summary:
        "Models OpenAI charges for that neither its model index nor its API catalogue lists; dated fine-tuning builds of a catalogued model are set aside as snapshots.",
      startHere: "is OpenAI pricing a model it has not published",
      mutates: false,
      agent: true,
      schema: z.object({}),
      cli: { args: [] },
      http: { method: "get", path: "/api/priced-uncatalogued" },
      handler: () => pricedUncatalogued(db),
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

/**
 * The one operation that is a declaration of its own, because the registry it belongs to is at the
 * length a declaration gets and `check-size` only turns the ratchet down. Nothing else distinguishes
 * it: it is read, built and documented exactly as every entry beside it is.
 */
function trafficOperation(db: Database, config: AppConfig): OperationMap[string] {
  return {
    section: "sources",
    summary: "What each source asks of the network and what it returns for it, ranked by bytes downloaded per event.",
    startHere: "which collector is downloading the most for the least, and should be narrowed next",
    note:
      "Ranked by `bytesPerEvent`, never by bytes: bytes alone name the largest catalogue, which " +
      "is usually doing its job, while bytes against what the collection produced name the " +
      "download that is mostly discarded. A null ratio is a window that produced no events, not " +
      "a free source, and those sort last rather than first. `bytesWire` is what crossed the " +
      "link and `bytesDecoded` is what had to be held in memory; far apart means compression is " +
      "working and the remaining cost is parsing, close together on a large body means nothing " +
      "is compressed at all. `requests` includes the cheap `nothingNew` probe, which is most of " +
      "some sources' request count and almost none of their bytes, and excludes transport " +
      "retries. `notModifiedShare` is the part that cost no body, so a low-traffic source with a " +
      "high share is a cache working rather than a collector that stopped. What a top row means " +
      "is to open that collector and compare the fields it reads against the answer it asks for " +
      "-- `bun run probe` against the live endpoint -- which is the half no counter can do. " +
      "`unmeasured` lists sources that collected in the window before anything was counted for " +
      "them; it empties as the window moves past the deploy.",
    mutates: false,
    agent: true,
    // Capped at the collection fold's horizon for the same reason `collection-cost` is: the
    // numbers come from `source_collection_days`, and a window reaching past the rows would be
    // answered from the days that happen to be left rather than refused.
    schema: z.object({ days: count(METRIC_DAYS, 7) }),
    cli: { args: [{ name: "days", optional: true }] },
    http: { method: "get", path: "/api/traffic" },
    handler: (input: { days: number }) => traffic(db, config, input.days),
  };
}
