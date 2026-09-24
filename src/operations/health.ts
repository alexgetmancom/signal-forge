import type { Database } from "bun:sqlite";
import { z } from "zod";
import { capabilityReport } from "../capabilities.js";
import type { AppConfig } from "../config.js";
import { buildOperationsGuide, OPERATION_SECTIONS, type OperationSection } from "../guide.js";
import { doctorReport } from "../reports/doctor.js";
import { listActionableIssues } from "../reports/issues.js";
import { keyStandings } from "../reports/keys.js";
import { statusReport } from "../reports/statusReport.js";
import { memoryReport } from "../runtime/observability.js";
import { dateIntegrity } from "../storage/dateIntegrity.js";
import { count, flag, type OperationMap, operationCatalog } from "./definition.js";

/** The "health" section of the operation registry; src/operations.ts joins the sections. */
export function healthOperations(db: Database, config: AppConfig, all: () => OperationMap): OperationMap {
  return {
    guide: {
      section: "health",
      summary: "The command catalog, the symptom index and what to do when the database is unusable.",
      startHere: "I do not know which command answers this",
      note: "Read-only. Ask for one section, or all, when the section names are not enough.",
      mutates: false,
      // Every MCP tool is already listed to an agent with its own summary; the catalog is what a
      // surface without that listing needs.
      agent: false,
      schema: z.object({ section: z.enum(OPERATION_SECTIONS).optional(), all: flag().optional() }),
      cli: { args: [{ name: "section", optional: true }] },
      http: { method: "get", path: "/api/guide" },
      handler: (input: { section?: OperationSection; all?: boolean }) =>
        buildOperationsGuide(operationCatalog(all()), input),
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
      handler: () => statusReport(db, config),
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
    keys: {
      section: "health",
      summary:
        "Credentials this deployment is short of, by the name of the setting: which are absent, which an upstream refused, and what stopped collecting for each.",
      startHere: "a source needs a key and I am about to supply it",
      note:
        "Asked when someone is about to fix a key, never as an opening ritual: a missing credential " +
        "is a standing fact about a deployment, and a report that recites it at the top of every " +
        "session teaches its reader to skip the one time it changed. Pass `all` to see the " +
        "capabilities that are fine too. Names of settings only; no value is ever read out.",
      mutates: false,
      agent: true,
      schema: z.object({ scope: z.enum(["attention", "all"]).default("attention") }),
      cli: { args: [{ name: "scope", optional: true }] },
      http: { method: "get", path: "/api/keys" },
      handler: (input: { scope: "attention" | "all" }) => keyStandings(db, config, input.scope),
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
    memory: {
      section: "health",
      summary: "Memory by day: typical and worst use, time near the container limit, restarts and OOM kills.",
      startHere: "how much memory does this use, and has it been killed for it",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(90, 7) }),
      cli: { args: [{ name: "days", optional: true }] },
      http: { method: "get", path: "/api/memory" },
      handler: (input: { days: number }) => memoryReport(db, input.days),
    },
  };
}
