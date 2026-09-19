import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { getHypothesis, listHypotheses } from "../hypotheses.js";
import { listLifecycleDeadlines } from "../lifecycle.js";
import { getModelFacts, listModelFacts } from "../modelFacts.js";
import { listPublications } from "../publications.js";
import { isSignalClass, news } from "../reports/news.js";
import { listStories } from "../stories.js";
import { count, identifier, type OperationMap } from "./definition.js";

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
        "What reached readers over the last N hours (default 24), by signal class, with raw event volume beside it.",
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
      summary: "Recent detected changes, including before and after evidence.",
      mutates: false,
      agent: true,
      schema: z.object({ limit: count(100, 20) }),
      cli: { args: [{ name: "limit", optional: true }] },
      http: { method: "get", path: "/api/events" },
      handler: (input: { limit: number }) =>
        db
          .query(
            "SELECT id,source,stream,entity_id,kind,confidence,evidence_type,authority,detected_at FROM events ORDER BY id DESC LIMIT ?",
          )
          .all(input.limit),
    },
    event: {
      section: "evidence",
      summary: "Full before/after evidence for one event.",
      startHere: "what does this claim actually rest on",
      mutates: false,
      agent: true,
      schema: z.object({ id: identifier }),
      cli: { args: [{ name: "id" }] },
      http: { method: "get", path: "/api/events/:id" },
      notFoundWhenEmpty: true,
      handler: (input: { id: number }) => db.query("SELECT * FROM events WHERE id=?").get(input.id),
    },
    stories: {
      section: "evidence",
      summary:
        "Deterministically correlated event stories with confidence, identity state, aliases and immutable evidence IDs.",
      mutates: false,
      agent: true,
      schema: z.object({
        since: z.string().datetime({ offset: true }).optional(),
        minConfidence: z.enum(["observed", "supported", "confirmed", "shipped"]).default("observed"),
        vendor: z.string().min(1).optional(),
        limit: count(100, 50),
      }),
      cli: { args: [{ name: "limit", optional: true }] },
      http: { method: "get", path: "/api/stories" },
      handler: (input: {
        since?: string | undefined;
        minConfidence: "observed" | "supported" | "confirmed" | "shipped";
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
      mutates: false,
      agent: true,
      schema: z.object({ days: count(365, 30) }),
      cli: { args: [{ name: "days", optional: true }] },
      http: { method: "get", path: "/api/deadlines" },
      handler: (input: { days: number }) => listLifecycleDeadlines(db, input.days),
    },
  };
}
