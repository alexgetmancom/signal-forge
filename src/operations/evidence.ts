import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { lifecycleState } from "../events/lifecycleState.js";
import type { Event } from "../events/types.js";
import { getHypothesis, listHypotheses } from "../hypotheses.js";
import { listLifecycleDeadlines } from "../lifecycle.js";
import { getModelFacts, listModelFacts } from "../modelFactsView.js";
import { listPublications } from "../publications.js";
import { eventEvidence } from "../reports/eventEvidence.js";
import { isSignalClass, news } from "../reports/news.js";
import { trace } from "../reports/trace.js";
import { listStories } from "../storiesView.js";
import { count, identifier, type OperationMap } from "./definition.js";

type EventRow = Pick<
  Event,
  "id" | "source" | "stream" | "entity_id" | "kind" | "confidence" | "evidence_type" | "authority" | "detected_at"
>;

/** The "evidence" section of the operation registry; src/operations.ts joins the sections. */
export function evidenceOperations(db: Database, config: AppConfig, _all: () => OperationMap): OperationMap {
  return {
    publications: {
      section: "evidence",
      summary: "Published text and target outcomes read from Solo Publisher, with archive coverage and freshness.",
      startHere: "what has been published through Solo Publisher",
      mutates: false,
      agent: true,
      schema: z.object({ limit: count(100, 20) }),
      cli: { args: [{ name: "limit", optional: true }] },
      http: { method: "get", path: "/api/publications" },
      handler: ({ limit }: { limit: number }) => listPublications(db, config, limit),
    },
    news: {
      section: "evidence",
      summary:
        "What reached readers over the last N hours (default 24), by signal class -- who was meant to hear it -- and beside it by claim, which is what actually happened, with raw event volume on both.",
      startHere: "what was news today",
      mutates: false,
      agent: true,
      schema: z.object({
        hours: count(168, 24),
        signal: z.string().refine(isSignalClass, "unknown signal class").optional(),
      }),
      cli: {
        args: [
          { name: "hours", optional: true },
          { name: "signal", optional: true },
        ],
      },
      http: { method: "get", path: "/api/news" },
      handler: (input: { hours: number; signal?: string | undefined }) =>
        news(db, {
          hours: input.hours,
          signal: input.signal && isSignalClass(input.signal) ? input.signal : undefined,
        }),
    },
    events: {
      section: "evidence",
      summary: "Recent detected changes, with the lifecycle state each one implies beside how well it holds.",
      mutates: false,
      agent: true,
      schema: z.object({ limit: count(100, 20) }),
      cli: { args: [{ name: "limit", optional: true }] },
      http: { method: "get", path: "/api/events" },
      // `lifecycle` is derived here rather than stored: it is a pure function of columns already on
      // the row, and `confidence` answers a different question -- how well the evidence holds, not
      // whether the subject is out. It is null for the events that are not about a product's life.
      handler: (input: { limit: number }) =>
        db
          .query<EventRow, [number]>(
            "SELECT id,source,stream,entity_id,kind,confidence,evidence_type,authority,detected_at FROM events ORDER BY id DESC LIMIT ?",
          )
          .all(input.limit)
          .map((row) => ({ ...row, lifecycle: lifecycleState(row) })),
    },
    event: {
      section: "evidence",
      summary:
        "Full before/after evidence for one event, and what became of it: the standing verdict with every rule that vetoed it, the batches it was folded into, the deliveries those became, and whether a reader has it.",
      startHere: "what does this claim actually rest on",
      mutates: false,
      agent: true,
      schema: z.object({ id: identifier }),
      cli: { args: [{ name: "id" }] },
      http: { method: "get", path: "/api/events/:id" },
      notFoundWhenEmpty: true,
      handler: (input: { id: number }) => eventEvidence(db, input.id),
    },
    trace: {
      section: "evidence",
      summary:
        "Every sighting of one name across every source, in order, with what each one did: batched, delivered, or held back and by which rule.",
      startHere: "what do we know about this name, and was anybody ever told",
      note: "The match is loose on purpose -- the name as typed, its normalized form, and that form with separators as wildcards, against both the event's entity id and its story's title -- because the caller has a string off a card rather than a key. `model` is the strict version and answers only for a subject that was identified, which is never the one being investigated. Read `batched` and `delivered` rather than `speaks`: the first says a message was built naming the event, the second that one was accepted, and `speaks` says only that no rule vetoed it.",
      mutates: false,
      agent: true,
      schema: z.object({ name: z.string().min(2), limit: count(500, 100) }),
      cli: { args: [{ name: "name" }, { name: "limit", optional: true }] },
      http: { method: "get", path: "/api/trace" },
      handler: (input: { name: string; limit: number }) => trace(db, input.name, input.limit),
    },
    stories: {
      section: "evidence",
      summary:
        "Deterministically correlated event stories with confidence, identity state, aliases and immutable evidence IDs.",
      mutates: false,
      agent: true,
      schema: z.object({
        since: z.string().datetime({ offset: true }).optional(),
        minConfidence: z.enum(["observed", "supported", "confirmed"]).default("observed"),
        vendor: z.string().min(1).optional(),
        limit: count(100, 50),
      }),
      cli: { args: [{ name: "limit", optional: true }] },
      http: { method: "get", path: "/api/stories" },
      handler: (input: {
        since?: string | undefined;
        minConfidence: "observed" | "supported" | "confirmed";
        vendor?: string | undefined;
        limit: number;
      }) => listStories(db, input),
    },
    models: {
      section: "evidence",
      summary: "Current structured model facts with event provenance.",
      mutates: false,
      agent: true,
      schema: z.object({ limit: count(100, 50) }),
      cli: { args: [{ name: "limit", optional: true }] },
      http: { method: "get", path: "/api/models" },
      handler: (input: { limit: number }) => listModelFacts(db, input),
    },
    model: {
      section: "evidence",
      summary: "Structured facts and conflicts for one canonical model ID.",
      mutates: false,
      agent: true,
      schema: z.object({ canonicalId: z.string().min(1) }),
      // A canonical ID carries slashes, so it is the rest of the path rather than one segment.
      cli: { args: [{ name: "canonicalId", rest: true }] },
      http: {
        method: "get",
        path: "/api/models/*",
        input: (request) => {
          const prefix = "/api/models/";
          const raw = request.path.startsWith(prefix) ? request.path.slice(prefix.length) : "";
          try {
            return { canonicalId: decodeURIComponent(raw) };
          } catch {
            return { canonicalId: "" };
          }
        },
      },
      notFoundWhenEmpty: true,
      handler: (input: { canonicalId: string }) => getModelFacts(db, input.canonicalId),
    },
    hypotheses: {
      section: "evidence",
      summary: "Deterministic hypotheses derived from independent story evidence.",
      mutates: false,
      agent: true,
      schema: z.object({
        status: z.enum(["emerging", "strengthening", "confirmed", "stale"]).optional(),
        limit: count(100, 50),
      }),
      cli: { args: [{ name: "limit", optional: true }] },
      http: { method: "get", path: "/api/hypotheses" },
      handler: (input: { status?: "emerging" | "strengthening" | "confirmed" | "stale"; limit: number }) =>
        listHypotheses(db, input),
    },
    hypothesis: {
      section: "evidence",
      summary: "One hypothesis and its supporting or resolving event evidence.",
      mutates: false,
      agent: true,
      schema: z.object({ id: identifier }),
      cli: { args: [{ name: "id" }] },
      http: { method: "get", path: "/api/hypotheses/:id" },
      notFoundWhenEmpty: true,
      handler: (input: { id: number }) => getHypothesis(db, input.id),
    },
    lifecycle_deadlines: {
      section: "evidence",
      summary: "Upcoming lifecycle deadlines and their reminder state.",
      startHere: "what is being retired, and has the channel been told",
      note:
        "Two kinds of deadline, told apart by `reminders`. A deprecation page is a vendor saying a " +
        "model ends, and it carries reminder rows at 30, 7 and 1 day. A router's catalogue carrying " +
        "an expiry date on a listing is a venue saying it stops serving one, which is a different " +
        "sentence with the same shape, so it accumulates with `reminders: []` and reaches no reader. " +
        "An empty list is therefore the answer and not a gap: known here, and nobody told.",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(365, 30) }),
      cli: { args: [{ name: "days", optional: true }] },
      http: { method: "get", path: "/api/deadlines" },
      handler: (input: { days: number }) => listLifecycleDeadlines(db, input.days),
    },
  };
}
