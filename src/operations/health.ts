import type { Database } from "bun:sqlite";
import { z } from "zod";
import { capabilityReport } from "../capabilities.js";
import type { AppConfig } from "../config.js";
import { buildOperationsGuide, OPERATION_SECTIONS, type OperationSection } from "../guide.js";
import { brokenReport } from "../reports/broken.js";
import { doctorReport } from "../reports/doctor.js";
import { flakySources } from "../reports/flakySources.js";
import { listActionableIssues } from "../reports/issues.js";
import { keyStandings } from "../reports/keys.js";
import { outages } from "../reports/outages.js";
import { releaseCheck } from "../reports/release.js";
import { sourceFailures } from "../reports/sourceFailures.js";
import { statusReport } from "../reports/statusReport.js";
import { usageReport } from "../reports/usage.js";
import { codeAnalytics } from "../runtime/metrics.js";
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
    broken: {
      section: "health",
      summary:
        "Everything any of the four readings calls broken, in one call: what is red now, what has gone quiet, what is losing collections, and which host is failing as one.",
      startHere: "opening a session, or something is wrong and I do not know where to look",
      note:
        "The four readings are blind to each other -- the present, an absence, a rate, a " +
        "correlation -- and each section says which one it is. Read `readings` first: a source " +
        "flagged by two of them is a different problem from one flagged by one, and that is the " +
        "only thing here the four commands cannot tell you separately. `issues`, `silent-sources`, " +
        "`flaky` and `outages` still answer on their own when the question is already narrow.",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(90, 3) }),
      cli: { args: [{ name: "days", optional: true }] },
      http: { method: "get", path: "/api/broken" },
      handler: (input: { days: number }) => brokenReport(db, config, input.days),
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
    flaky: {
      section: "health",
      summary:
        "Sources that fail often but not always, by failure rate over the last N days: the broken state that is neither red right now nor silent.",
      startHere: "a source looks fine but I suspect it is losing collections",
      note:
        "Ask this alongside `issues` and `silent-sources`. Those two read the present and the " +
        "absence; this reads the rate, which is the only way a source that fails two attempts in " +
        "three and succeeds on the third becomes visible. `arena` sat at 73% for three days without " +
        "appearing in either of the others.",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(90, 3) }),
      cli: { args: [{ name: "days", optional: true }] },
      http: { method: "get", path: "/api/flaky" },
      handler: (input: { days: number }) => flakySources(db, config, input.days),
    },
    outages: {
      section: "health",
      summary:
        "Failures grouped by the host their sources share, so one upstream falling over is one line instead of one line per source pointed at it.",
      startHere: "several sources are flaky at once and I want to know whether it is one cause",
      note:
        "Read `concurrentMinutes` first: two sources of a group failing inside the same minute is " +
        "not something independent failures do. The five `artificial-analysis` sources logged 53 " +
        "ECONNRESET in seven days at ten per cent each -- five entries in `flaky`, one host.",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(90, 7) }),
      cli: { args: [{ name: "days", optional: true }] },
      http: { method: "get", path: "/api/outages" },
      handler: (input: { days: number }) => outages(db, config, input.days),
    },
    failures: {
      section: "health",
      summary:
        "Why one source is failing: the failure kinds it produced, and the structure of each complaint -- which field of how many entries, not what was in it.",
      startHere: "flaky says a source fails and I need to know what to fix",
      note:
        "The counterpart to `flaky`, which reads the rate. A schema failure records the field paths " +
        "the parse objected to, so `arena` saying `response did not match the schema` becomes a " +
        "field name. No upstream value is ever kept, which is why the body of a failed parse is not.",
      mutates: false,
      agent: true,
      schema: z.object({ source: z.string().min(1), days: count(90, 7) }),
      cli: { args: [{ name: "source" }, { name: "days", optional: true }] },
      http: { method: "get", path: "/api/failures/:source" },
      handler: (input: { source: string; days: number }) => sourceFailures(db, input.source, input.days),
    },
    timings: {
      section: "health",
      summary:
        "What this service spends its time in: calls, average, p50 and p95 per instrumented section, slowest first.",
      startHere: "something is slow, or I want to know what a change cost",
      note:
        "This was called `code_analytics` and sat in the `sources` section under the name of its " +
        "table, and ten raw `sql` queries were written against `code_metrics` by hand rather than " +
        "found. Ask `timings --name pipeline --limit 5`; the per-hour series needs `--timeline` " +
        "because the usual question is what is slow, not when. After a deploy ask " +
        "`timings --since boot`: buckets are hourly, so a release at 13:34 poisons the 13:00 one, " +
        "and `--since` names that hour in `straddled` and leaves it out rather than averaging the " +
        "two builds together. It also takes an ISO instant or a span such as 90m, 6h, 2d.",
      mutates: false,
      agent: true,
      schema: z.object({
        days: count(90, 7),
        name: z.string().min(1).optional(),
        limit: count(500, 20),
        timeline: flag().optional(),
        since: z.string().min(1).optional(),
      }),
      cli: {
        args: [
          { name: "days", optional: true },
          { name: "name", optional: true },
        ],
      },
      http: { method: "get", path: "/api/timings" },
      handler: (input: { days: number; name?: string; limit: number; timeline?: boolean; since?: string }) =>
        codeAnalytics(db, input.days, Date.now(), {
          name: input.name,
          limit: input.limit,
          timeline: input.timeline,
          since: input.since,
        }),
    },
    usage: {
      section: "health",
      summary:
        "Which commands are actually used, which fail, and the raw queries asked by hand often enough to deserve a command of their own.",
      startHere: "what should the next command be, and is anything I shipped going unused",
      note:
        "Read from the operator journal, which records every call and not only the ones that write. " +
        "The `askedByHand` list is the useful half: a SQL shape asked more than once is a report " +
        "nobody wrote yet, and the repeat is the evidence for writing it.",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(90, 14) }),
      cli: { args: [{ name: "days", optional: true }] },
      http: { method: "get", path: "/api/usage" },
      handler: (input: { days: number }) => usageReport(db, input.days),
    },
    verify: {
      section: "health",
      summary:
        "Whether the running build is the one just pushed: schema version, hot-path indexes, a named symbol in the built code, and failures since the restart.",
      startHere: "I just deployed and want to know it landed",
      note:
        "Name a symbol the release added. Everything else can pass while the container runs last " +
        "week's image, because the database outlives the image and only the built code can say " +
        "which release is loaded.",
      mutates: false,
      agent: true,
      schema: z.object({ symbol: z.string().min(1).optional(), directory: z.string().min(1).optional() }),
      cli: {
        args: [
          { name: "symbol", optional: true },
          { name: "directory", optional: true },
        ],
      },
      http: { method: "get", path: "/api/verify" },
      handler: (input: { symbol?: string; directory?: string }) => releaseCheck(db, input),
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
