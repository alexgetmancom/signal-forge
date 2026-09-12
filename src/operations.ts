import type { Database } from "bun:sqlite";
import { z } from "zod";
import { capabilityReport } from "./capabilities.js";
import type { AppConfig } from "./config.js";
import { clearCredentialCircuit, openCredentialCircuits } from "./credentials.js";
import { requireDeliveryVerification, resolveDeliveryVerification } from "./deliveryVerification.js";
import { doctorReport } from "./doctor.js";
import {
  buildOperationsGuide,
  OPERATION_SECTIONS,
  type OperationCatalogEntry,
  type OperationSection,
  usageLine,
} from "./guide.js";
import { getHypothesis, listHypotheses } from "./hypotheses.js";
import { listActionableIssues } from "./issues.js";
import { listOperatorActions } from "./journal.js";
import { leadTime } from "./leadTime.js";
import { listLifecycleDeadlines } from "./lifecycle.js";
import { getModelFacts, listModelFacts } from "./modelFacts.js";
import { pollSources } from "./poller.js";
import { listPublications, syncPublications } from "./publications.js";
import { deepSeekUsage } from "./runtime/deepseekUsage.js";
import { codeAnalytics } from "./runtime/metrics.js";
import { signalQuality } from "./signalQuality.js";
import { sourceJobs } from "./sources/registry.js";
import { dateIntegrity } from "./storage/dateIntegrity.js";
import { listStories } from "./stories.js";

/**
 * One entry per operation, and every operator surface is a projection of it: the CLI dispatch and
 * its usage lines, the HTTP API, the MCP tool list and the guide catalog. Adding an operation is
 * this one entry — the alternative, which this replaced, was four edits and a usage string that
 * had already drifted from the commands it described.
 *
 * `mutates` and `agent` are the two fields that are not documentation. A mutation is journalled on
 * whichever surface it was run from, and `agent: false` keeps an operation out of MCP entirely:
 * every tool is listed in full to an agent before anything is asked, so a read is on because
 * diagnosis is what that surface is for, and a mutation is on only when it is part of routine
 * delivery work. Anything that touches credentials or the host is off regardless.
 */
type CliArgument = { name: string; optional?: boolean; rest?: boolean };

/** What a surface hands the registry: path, query and body, already separated, never parsed. */
type OperationRequest = {
  path: string;
  params: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
  body: unknown;
};

type OperationDefinition = {
  section: OperationSection;
  summary: string;
  /** The question an operator arrives with, when this command is where the answer starts. */
  startHere?: string;
  note?: string;
  mutates: boolean;
  agent: boolean;
  schema: z.ZodType;
  /** Absent means the operation is not on the CLI. */
  cli?: { args?: readonly CliArgument[] };
  /** Absent means the operation is not on the HTTP API. */
  http?: { method: "get" | "post"; path: string; input?: (request: OperationRequest) => unknown };
  /** A handler that answers with nothing is a missing entity, not an empty result. */
  notFoundWhenEmpty?: boolean;
  handler: (input: never) => unknown;
};

export type OperationMap = Record<string, OperationDefinition>;

/** MCP tools are named with underscores; the CLI is spelled the way a shell command is spelled. */
export function cliCommand(name: string): string {
  return name.replaceAll("_", "-");
}

export function operationCatalog(defs: OperationMap): OperationCatalogEntry[] {
  return Object.entries(defs).map(([name, def]) => ({
    name: cliCommand(name),
    usage: def.cli
      ? usageLine(cliCommand(name), def.cli.args ?? [])
      : `${def.http?.method.toUpperCase()} ${def.http?.path}`,
    summary: def.summary,
    section: def.section,
    mutates: def.mutates,
    agent: def.agent,
    ...(def.startHere ? { startHere: def.startHere } : {}),
    ...(def.note ? { note: def.note } : {}),
    ...(def.http ? { http: `${def.http.method.toUpperCase()} ${def.http.path}` } : {}),
  }));
}

/**
 * Run one operation the way a surface runs it: validate the input against its schema, then hand it
 * to the handler. Anything calling an operation directly goes through here, so nothing reaches a
 * handler by a route that skipped its schema.
 */
export function callOperation(defs: OperationMap, name: string, input: unknown = {}): unknown {
  const definition = defs[name];
  if (!definition) throw new Error(`Unknown operation: ${name}`);
  return (definition.handler as (value: unknown) => unknown)(definition.schema.parse(input));
}

/** Query strings and shell arguments arrive as text; MCP sends JSON. Both parse with coercion. */
const count = (max: number, fallback: number) => z.coerce.number().int().min(1).max(max).default(fallback);
const identifier = z.coerce.number().int().positive();

export function operations(db: Database, config: AppConfig): OperationMap {
  const defs: OperationMap = {
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
    sync_publications: {
      section: "host",
      summary: "Refresh the recent Solo Publisher archive without publishing or changing anything in Studio.",
      mutates: true,
      agent: false,
      schema: z.object({}),
      cli: {},
      handler: () => syncPublications(db, config),
    },
    guide: {
      section: "health",
      summary: "The command catalog, the symptom index and what to do when the database is unusable.",
      startHere: "I do not know which command answers this",
      note: "Read-only. Ask for one section, or all, when the section names are not enough.",
      mutates: false,
      // Every MCP tool is already listed to an agent with its own summary; the catalog is what a
      // surface without that listing needs.
      agent: false,
      schema: z.object({ section: z.enum(OPERATION_SECTIONS).optional(), all: z.coerce.boolean().optional() }),
      cli: { args: [{ name: "section", optional: true }] },
      http: { method: "get", path: "/api/guide" },
      handler: (input: { section?: OperationSection; all?: boolean }) =>
        buildOperationsGuide(operationCatalog(defs), input),
    },
    doctor: {
      section: "health",
      summary: "Whether this deployment is configured, has a database and has a verified recent backup.",
      startHere: "is this deployment healthy, and is it actually backed up",
      mutates: false,
      agent: true,
      schema: z.object({}),
      cli: {},
      http: { method: "get", path: "/api/doctor" },
      handler: () => doctorReport(config),
    },
    status: {
      section: "health",
      summary: "Source health, configured destinations and delivery queue counts.",
      startHere: "what is this service doing right now",
      mutates: false,
      agent: true,
      schema: z.object({}),
      cli: {},
      http: { method: "get", path: "/api/status" },
      handler: () => {
        const capabilities = capabilityReport(db, config);
        return {
          sources: sourceJobs(db, config).map((job) => ({
            id: job.id,
            label: job.label,
            group: job.group,
            stream: job.stream,
            authority: job.authority,
            mode: job.mode,
            intervalSeconds: job.intervalSeconds,
            requiredCapabilities: job.requiredCapabilities ?? [],
            ...(db
              .query<
                {
                  last_success: string | null;
                  last_error: string | null;
                  checked_at: string | null;
                  retry_at: string | null;
                },
                [string]
              >("SELECT last_success,last_error,checked_at,retry_at FROM sources WHERE id=?")
              .get(job.id) ?? {}),
          })),
          unavailable: capabilities
            .filter((entry) => entry.status === "missing" || entry.status === "rejected")
            .map((entry) => `${entry.id}: ${entry.status}`),
          destinations: config.destinations,
          digestEvents: db
            .query("SELECT COUNT(*) AS count FROM batch_events e JOIN batches b ON b.id=e.batch_id WHERE b.sealed=0")
            .get(),
          deliveries: db.query("SELECT status,COUNT(*) AS count FROM deliveries GROUP BY status").all(),
          capabilities,
          issues: listActionableIssues(db, config),
        };
      },
    },
    issues: {
      section: "health",
      summary: "Current source, delivery, worker, restart, backup and capability problems requiring attention.",
      startHere: "something is wrong and I do not know what",
      mutates: false,
      agent: true,
      schema: z.object({}),
      cli: {},
      http: { method: "get", path: "/api/issues" },
      handler: () => listActionableIssues(db, config),
    },
    capabilities: {
      section: "health",
      summary: "Sanitized readiness of enabled integrations, including credentials an upstream has refused.",
      mutates: false,
      agent: true,
      schema: z.object({}),
      cli: {},
      http: { method: "get", path: "/api/capabilities" },
      handler: () => capabilityReport(db, config),
    },
    date_integrity: {
      section: "health",
      summary: "Stored instants that are not ISO-8601 UTC, by table and column.",
      startHere: "a date in a report looks like the wrong day",
      note: "The database rejects badly shaped instants on write; this finds rows written before it did.",
      mutates: false,
      agent: true,
      schema: z.object({ limit: count(100, 10) }),
      cli: { args: [{ name: "limit", optional: true }] },
      http: { method: "get", path: "/api/date-integrity" },
      handler: (input: { limit: number }) => dateIntegrity(db, input.limit),
    },
    deliveries: {
      section: "delivery",
      summary: "Recent delivery outcomes. Ambiguous sends require checking the destination.",
      mutates: false,
      agent: true,
      schema: z.object({ limit: count(100, 20) }),
      cli: { args: [{ name: "limit", optional: true }] },
      http: { method: "get", path: "/api/deliveries" },
      handler: (input: { limit: number }) =>
        db
          .query(
            "SELECT id,batch_id,destination_id,status,attempts,external_id,error,verification_source,verified_at,verification_attempts,last_verification_error FROM deliveries ORDER BY id DESC LIMIT ?",
          )
          .all(input.limit),
    },
    deliveries_needing_verification: {
      section: "delivery",
      summary: "Ambiguous or manually unresolved deliveries that must be checked without resending.",
      startHere: "a send may or may not have reached the channel",
      mutates: false,
      agent: true,
      schema: z.object({ limit: count(100, 20) }),
      cli: { args: [{ name: "limit", optional: true }] },
      http: { method: "get", path: "/api/deliveries/verification" },
      handler: (input: { limit: number }) =>
        db
          .query(
            "SELECT id,batch_id,destination_id,status,attempts,external_id,error,verification_attempts,last_verification_error FROM deliveries WHERE status IN ('ambiguous','verification_required') ORDER BY id DESC LIMIT ?",
          )
          .all(input.limit),
    },
    require_delivery_verification: {
      section: "delivery",
      summary: "Mark one ambiguous delivery for manual verification; this never sends a second message.",
      mutates: true,
      agent: true,
      schema: z.object({ id: identifier }),
      cli: { args: [{ name: "id" }] },
      http: { method: "post", path: "/api/deliveries/:id/verification" },
      handler: (input: { id: number }) => requireDeliveryVerification(db, input.id),
    },
    resolve_delivery_verification: {
      section: "delivery",
      summary: "Record the result of manual delivery verification without sending a second message.",
      note: "Record what the destination actually shows. This decides the outcome; nothing re-reads it later.",
      mutates: true,
      agent: true,
      schema: z.object({
        id: identifier,
        outcome: z.enum(["sent", "failed"]),
        externalId: z.string().min(1).optional(),
      }),
      cli: { args: [{ name: "id" }, { name: "outcome" }, { name: "externalId", optional: true }] },
      http: {
        method: "post",
        path: "/api/deliveries/:id/verification/resolve",
        input: (request) => ({
          ...(request.body && typeof request.body === "object" ? request.body : {}),
          id: request.params.id,
        }),
      },
      handler: (input: { id: number; outcome: "sent" | "failed"; externalId?: string | undefined }) =>
        resolveDeliveryVerification(db, input.id, input.outcome, input.externalId),
    },
    suppressions: {
      section: "delivery",
      summary: "Events that were subscribed to but produced no message, with the rule and the reason in words.",
      startHere: "an event was collected but no subscriber saw it",
      mutates: false,
      agent: true,
      schema: z.object({ destinationId: z.string().min(1).optional(), limit: count(100, 20) }),
      cli: { args: [{ name: "limit", optional: true }] },
      http: { method: "get", path: "/api/suppressions" },
      handler: (input: { destinationId?: string | undefined; limit: number }) =>
        db
          .query(
            `SELECT s.event_id,s.destination_id,s.batch_id,s.reason,s.detail,s.recorded_at,
                    e.source,e.stream,e.kind,e.entity_id
             FROM suppressions s JOIN events e ON e.id=s.event_id
             WHERE (?1 IS NULL OR s.destination_id=?1)
             ORDER BY s.recorded_at DESC, s.event_id DESC LIMIT ?2`,
          )
          .all(input.destinationId ?? null, input.limit),
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
    clear_credential_circuit: {
      section: "host",
      summary: "Declare one refused credential replaced, so its sources are scheduled again.",
      note: "Rotate the credential and restart the service first; nothing here re-checks it.",
      mutates: true,
      // Credentials are the owner's, not an agent's.
      agent: false,
      schema: z.object({ capabilityId: z.string().min(1) }),
      cli: { args: [{ name: "capabilityId" }] },
      http: { method: "post", path: "/api/credentials/:capabilityId/clear" },
      handler: (input: { capabilityId: string }) => clearCredentialCircuit(db, input.capabilityId),
    },
    journal: {
      section: "host",
      summary: "Every mutation an operator has run, on whichever surface they ran it from.",
      startHere: "has somebody already settled this by hand",
      mutates: false,
      agent: true,
      schema: z.object({ operation: z.string().min(1).optional(), limit: count(200, 20) }),
      cli: { args: [{ name: "limit", optional: true }] },
      http: { method: "get", path: "/api/journal" },
      handler: (input: { operation?: string | undefined; limit: number }) => listOperatorActions(db, input),
    },
    poll: {
      section: "host",
      summary: "Collect every due source once, in this process, under the collection lock.",
      note: "The running service polls on its own schedule; this is for a source being investigated.",
      mutates: true,
      // A collector run from an agent is a write to every source's state and a possible delivery.
      agent: false,
      schema: z.object({}),
      cli: {},
      handler: async () => {
        const outcome = await pollSources(db, config, true);
        return {
          ...outcome,
          message: outcome.collected
            ? `Collection cycle finished over ${outcome.sources} due source${outcome.sources === 1 ? "" : "s"}`
            : "Another collection cycle is running; nothing was collected",
        };
      },
    },
  };
  return defs;
}
