import type { Database } from "bun:sqlite";
import { capabilityReport } from "../capabilities.js";
import type { AppConfig } from "../config.js";
import { openCredentialCircuits } from "../credentials.js";
import { boardFailures, sourceHealth } from "../status.js";
import { readState } from "../storage/appState.js";
import { databaseSize } from "../storage/retention.js";
import { backupStatus } from "./doctor.js";

/** Where growth stops being normal and becomes something to look at, rather than to discover. */
const DATABASE_SIZE_BUDGET = 5 * 1024 ** 3;

function gigabytes(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

export type IssueKind =
  | "source_failed"
  | "collection_degraded"
  | "delivery_failed"
  | "delivery_blocked"
  | "delivery_ambiguous"
  | "delivery_stuck"
  | "worker_failed"
  | "worker_stale"
  | "restart_loop"
  | "capability_missing"
  | "capability_rejected"
  | "backup_stale"
  | "board_stalled"
  | "database_oversized";
type IssueSeverity = "warning" | "error" | "critical";

export type ActionableIssue = {
  id: string;
  kind: IssueKind;
  severity: IssueSeverity;
  entity: string;
  source?: string;
  destination?: string;
  firstSeenAt: string;
  updatedAt: string;
  /**
   * When the poller will ask this source again, for the issues where waiting is the right answer.
   *
   * A failing source and a rate-limited one read identically in a list -- both say "not
   * collecting" -- and the difference that matters is whether anybody needs to do anything. The
   * backoff already decided, and until now it kept the decision to itself, so the only way to know
   * whether a red row would clear on its own was to query `sources` by hand.
   */
  retryAt?: string | null;
  /** The family this source belongs to, on the issues where the family is the story. */
  group?: string;
  /** How many of that family are failing at once, which is the difference between one cause and several. */
  groupFailing?: number;
  message: string;
  hint: string;
};

type WorkerState = {
  state?: string;
  lastStartedAt?: string;
  lastFinishedAt?: string | null;
  lastError?: string | null;
  lastHeartbeatAt?: string;
  heartbeatIntervalMs?: number;
};

const STUCK_DELIVERY_MS = 5 * 60 * 1000;

function issueTime(value: string | null | undefined, now: number): string {
  if (value && Number.isFinite(Date.parse(value))) return value;
  return new Date(now).toISOString();
}

function readJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Sources of one family failing together, marked as one cause rather than counted as several.
 *
 * `arena` and `arena-leaderboards` are two rows in this list and one broken page: both stopped on
 * 2026-09-24 because the site stopped putting its data in the HTML, and each was reported as a
 * collector to open. Two collectors were not broken. The registry already groups sources by the
 * thing they read, so when more than one of a group is failing at the same time that is what the
 * issue says, and the reader looks at the site once instead of at the collectors twice.
 */
function sharedCause(issues: ActionableIssue[], health: readonly { id: string; group: string }[]): void {
  const groupOf = new Map(health.map((entry) => [entry.id, entry.group]));
  const size = new Map<string, number>();
  for (const entry of health) size.set(entry.group, (size.get(entry.group) ?? 0) + 1);
  const failing = new Map<string, string[]>();
  for (const issue of issues) {
    const group = issue.source ? groupOf.get(issue.source) : undefined;
    if (group && issue.source) failing.set(group, [...(failing.get(group) ?? []), issue.source]);
  }
  for (const issue of issues) {
    const group = issue.source ? groupOf.get(issue.source) : undefined;
    const peers = group ? (failing.get(group) ?? []) : [];
    if (!group || peers.length < 2) continue;
    issue.group = group;
    issue.groupFailing = peers.length;
    issue.hint = `${issue.hint} ${peers.length} of the ${size.get(group)} ${group} sources are failing at once (${peers.join(", ")}), so this is one upstream to look at before it is ${peers.length} collectors to open.`;
  }
}

/** The single read model for failures that require the owner's attention right now. */
export function listActionableIssues(db: Database, config: AppConfig, now = Date.now()): ActionableIssue[] {
  const issues: ActionableIssue[] = [];
  const health = sourceHealth(db, config, now);
  const sourceWorker = readState(db, "worker:sources");
  const sourceWorkerState = sourceWorker ? readJson<WorkerState>(sourceWorker, {}) : {};
  const sourceCycleFinished = sourceWorkerState.state === "idle" && Boolean(sourceWorkerState.lastFinishedAt);
  const capabilities = capabilityReport(db, config);
  const circuits = new Map(openCredentialCircuits(db).map((circuit) => [circuit.capabilityId, circuit]));
  // A refused credential is one fix, and its capability issue already counts the sources it stopped.
  // Listing each of them again turned one expired Artificial Analysis key into six issues on
  // production on 2026-09-18.
  const refused = new Set(
    capabilities.filter((capability) => capability.status === "rejected").flatMap((entry) => entry.enabledSources),
  );
  for (const entry of health) {
    if (refused.has(entry.id)) continue;
    const rateLimited = entry.state === "blocked" && entry.detail.startsWith("rate limited");
    const unobservedAfterCycle = entry.state === "idle" && sourceCycleFinished;
    if (
      !(
        entry.state === "failing" ||
        entry.state === "stale" ||
        entry.state === "degraded" ||
        rateLimited ||
        unobservedAfterCycle
      )
    )
      continue;
    // When it started and when it was last confirmed are different questions. Reading both from
    // checked_at reported every outage as a moment old, however many days it had been running.
    const row = db
      .query<
        { checked_at: string | null; failure_started_at: string | null; failures: number; retry_at: string | null },
        [string]
      >("SELECT checked_at,failure_started_at,failures,retry_at FROM sources WHERE id=?")
      .get(entry.id);
    // One short answer rejected is the guard working, not a source in trouble. The arena serves a
    // roster missing a quarter or more of itself several times a week and every time the next
    // answer is whole, measured to 2026-09-16; two short answers in a row is when to look.
    if (entry.state === "degraded" && (row?.failures ?? 0) < 2) continue;
    const checked = row?.checked_at;
    const started = row?.failure_started_at ?? checked;
    issues.push({
      id: entry.id,
      kind: entry.state === "degraded" ? "collection_degraded" : "source_failed",
      severity: rateLimited ? "warning" : entry.state === "degraded" ? "critical" : "error",
      entity: entry.id,
      source: entry.id,
      firstSeenAt: issueTime(started, now),
      updatedAt: issueTime(checked, now),
      retryAt: row?.retry_at ?? null,
      message: `${entry.label} ${
        entry.state === "stale"
          ? "is stale"
          : entry.state === "degraded"
            ? "returned a suspiciously smaller collection"
            : unobservedAfterCycle
              ? "has no observation after the source worker completed a cycle"
              : "is not collecting successfully"
      }: ${entry.detail}`,
      hint: rateLimited
        ? "Wait for the upstream limit to clear; do not increase polling."
        : unobservedAfterCycle
          ? "Inspect why the source was not scheduled or persisted; an enabled source must produce an observation on its first cycle."
          : entry.state === "degraded"
            ? // The guard refused a short answer and kept what was already stored, so nothing is
              // lost and nothing resumes on its own either. The way out is one of two commands and
              // neither was named here: on production the shrink guard refused `arena` sixty-four
              // times in a week while `accept-shrink` -- which exists for exactly this decision --
              // had never once been called.
              "Compare the short answer against the upstream before resuming: the last known-good records were kept. If the smaller collection is real, `accept-shrink <source>` lets the next one through; `failures <source>` says how long it has been refusing and by how much."
            : "Inspect the collector and its upstream response.",
    });
  }

  const deliveries = db
    .query<
      {
        id: number;
        destination_id: string;
        status: "failed" | "ambiguous" | "verification_required";
        updated_at: string;
        error: string | null;
      },
      []
    >(
      "SELECT id,destination_id,status,updated_at,error FROM deliveries WHERE status IN ('failed','ambiguous','verification_required') ORDER BY id",
    )
    .all();
  // A destination that has sent something since answers the question a failed row raises: the
  // channel works, and that one message is history rather than a channel to go and fix. A failure
  // with nothing successful after it is the opposite -- the wire is silently down -- and stays
  // actionable until it is. An ambiguous send is never history: somebody has to go and look.
  const lastSent = new Map(
    db
      .query<{ destination_id: string; id: number }, []>(
        "SELECT destination_id,MAX(id) AS id FROM deliveries WHERE status='sent' GROUP BY destination_id",
      )
      .all()
      .map((row) => [row.destination_id, row.id] as const),
  );
  for (const delivery of deliveries) {
    const updatedAt = issueTime(delivery.updated_at, now);
    const ambiguous = delivery.status !== "failed";
    if (!ambiguous && (lastSent.get(delivery.destination_id) ?? 0) > delivery.id) continue;
    issues.push({
      id: `delivery:${delivery.id}`,
      kind: ambiguous ? "delivery_ambiguous" : "delivery_failed",
      severity: ambiguous ? "critical" : "error",
      entity: String(delivery.id),
      destination: delivery.destination_id,
      firstSeenAt: updatedAt,
      updatedAt,
      // The platform's own words, trimmed: "is failed" sends the reader to the database, where
      // "403 Missing Permissions" sends them to the channel's permissions, which is the fix.
      message: `Delivery ${delivery.id} to ${delivery.destination_id} is ${delivery.status}${
        delivery.error ? `: ${delivery.error.replace(/\s+/g, " ").slice(0, 160)}` : ""
      }`,
      hint: ambiguous
        ? "Verify the destination before any retry; the send may already have reached the audience."
        : "Inspect the stored platform response and destination configuration.",
    });
  }

  // A destination that refuses the bot holds its messages rather than losing them; that is only
  // useful if somebody is told the door is shut. One issue per destination, dated from its oldest
  // waiting message, carrying the platform's reason.
  const blocked = db
    .query<{ destination_id: string; waiting: number; oldest: string; error: string }, []>(
      `SELECT b.destination_id,
              (SELECT COUNT(*) FROM deliveries w WHERE w.destination_id=b.destination_id AND w.status='pending') AS waiting,
              MIN(b.updated_at) AS oldest,MAX(b.error) AS error
       FROM deliveries b WHERE b.status='pending' AND b.error LIKE 'Blocked:%' GROUP BY b.destination_id`,
    )
    .all();
  for (const row of blocked) {
    const since = issueTime(row.oldest, now);
    issues.push({
      id: `destination:${row.destination_id}:blocked`,
      kind: "delivery_blocked",
      severity: "error",
      entity: row.destination_id,
      destination: row.destination_id,
      firstSeenAt: since,
      updatedAt: since,
      message: `${row.destination_id} refuses the bot; ${row.waiting} message${row.waiting === 1 ? "" : "s"} waiting — ${row.error
        .slice("Blocked:".length)
        .trim()
        .slice(0, 160)}`,
      hint: "Give the bot View Channel, Send Messages, Embed Links and Attach Files there; waiting messages are sent in order within ten minutes.",
    });
  }

  const stuckDeliveries = db
    .query<{ id: number; destination_id: string; updated_at: string }, [string]>(
      "SELECT id,destination_id,updated_at FROM deliveries WHERE status='sending' AND updated_at<? ORDER BY updated_at",
    )
    .all(new Date(now - STUCK_DELIVERY_MS).toISOString());
  for (const delivery of stuckDeliveries) {
    const updatedAt = issueTime(delivery.updated_at, now);
    issues.push({
      id: `delivery:${delivery.id}:stuck`,
      kind: "delivery_stuck",
      severity: "critical",
      entity: String(delivery.id),
      destination: delivery.destination_id,
      firstSeenAt: updatedAt,
      updatedAt,
      message: `Delivery ${delivery.id} to ${delivery.destination_id} has been sending for more than five minutes`,
      hint: "Inspect the provider and process before deciding whether this delivery needs manual verification; do not retry it automatically.",
    });
  }

  // Growth was invisible until somebody went looking, by which time the database was a gigabyte
  // and the payloads behind two thirds of it had already been deleted by hand.
  const size = databaseSize(db);
  if (size.bytes > DATABASE_SIZE_BUDGET) {
    const seenAt = new Date(now).toISOString();
    issues.push({
      id: "database:size",
      kind: "database_oversized",
      severity: "warning",
      entity: "database",
      firstSeenAt: seenAt,
      updatedAt: seenAt,
      message: `The database holds ${gigabytes(size.bytes)} GB, of which ${gigabytes(size.snapshotBytes)} GB is compressed raw payloads`,
      hint: "Check which sources serve the largest payloads before widening retention; deleting a payload an event points at destroys its evidence.",
    });
  }

  // A board Discord refuses keeps showing its last accepted version, so the channel looks current
  // while it is frozen. Nothing else can tell the difference.
  for (const failure of boardFailures(db))
    issues.push({
      id: `board:${failure.board}`,
      kind: "board_stalled",
      severity: "error",
      entity: failure.board,
      firstSeenAt: issueTime(failure.firstSeenAt, now),
      updatedAt: issueTime(failure.updatedAt, now),
      message: `The ${failure.board} board is frozen at its last accepted version: ${failure.reason}`,
      hint: "Inspect the render and the channel's permissions; the board in the channel is stale until this clears.",
    });

  const workerRows = db
    .query<{ key: string; value: string }, []>("SELECT key,value FROM app_state WHERE key LIKE 'worker:%'")
    .all();
  for (const row of workerRows) {
    const state = readJson<WorkerState>(row.value, {});
    const worker = row.key.slice("worker:".length);
    if (state.state === "failed") {
      const updatedAt = issueTime(state.lastFinishedAt ?? state.lastStartedAt, now);
      issues.push({
        id: `worker:${worker}`,
        kind: "worker_failed",
        severity: "error",
        entity: worker,
        firstSeenAt: updatedAt,
        updatedAt,
        message: `Worker ${worker} failed its last cycle`,
        hint: "Inspect the worker log and restore the failed dependency before restarting it repeatedly.",
      });
    }
    if (state.state === "running") {
      const heartbeat = state.lastHeartbeatAt ?? state.lastStartedAt;
      const heartbeatMs = Number(state.heartbeatIntervalMs);
      const heartbeatAt = heartbeat ? Date.parse(heartbeat) : Number.NaN;
      const staleAfterMs = Number.isFinite(heartbeatMs) ? Math.max(120_000, heartbeatMs * 3) : null;
      if (staleAfterMs !== null && Number.isFinite(heartbeatAt) && now - heartbeatAt > staleAfterMs) {
        const updatedAt = issueTime(heartbeat, now);
        issues.push({
          id: `worker:${worker}:stale`,
          kind: "worker_stale",
          severity: "critical",
          entity: worker,
          firstSeenAt: updatedAt,
          updatedAt,
          message: `Worker ${worker} has not sent a heartbeat for ${Math.round((now - heartbeatAt) / 1000)} seconds`,
          hint: "Inspect the in-flight operation and process health; do not assume an unfinished external operation is safe to retry.",
        });
      }
    }
  }

  const runtime = readState(db, "runtime");
  const runtimeState = runtime ? readJson<{ uncleanRestarts?: string[] }>(runtime, {}) : {};
  const restarts = (runtimeState.uncleanRestarts ?? []).filter((value) => Date.parse(value) >= now - 30 * 60 * 1000);
  if (restarts.length >= 3) {
    const first = restarts[0];
    const last = restarts.at(-1);
    issues.push({
      id: "runtime:restart-loop",
      kind: "restart_loop",
      severity: "critical",
      entity: "runtime",
      firstSeenAt: issueTime(first, now),
      updatedAt: issueTime(last, now),
      message: `Service restarted ${restarts.length} times without a clean stop in 30 minutes`,
      hint: "Stop the loop and inspect the failing worker or process exit before allowing another restart.",
    });
  }

  for (const capability of capabilities) {
    if (capability.status !== "missing" && capability.status !== "rejected") continue;
    const rejected = capability.status === "rejected";
    // A refusal has a recorded start; a credential that was never configured has none.
    const circuit = rejected ? circuits.get(capability.id) : undefined;
    issues.push({
      id: `capability:${capability.id}`,
      kind: rejected ? "capability_rejected" : "capability_missing",
      severity: "error",
      entity: capability.id,
      firstSeenAt: issueTime(circuit?.openedAt, now),
      updatedAt: issueTime(circuit?.lastRejectedAt, now),
      message: rejected
        ? `Capability ${capability.id} was refused by its upstream; ${capability.enabledSources.length} source${capability.enabledSources.length === 1 ? " is" : "s are"} not being collected`
        : `Capability ${capability.id} is missing ${capability.missingCount} required credential${capability.missingCount === 1 ? "" : "s"}`,
      hint: rejected
        ? "Rotate the credential and restart the service, then clear-credential-circuit to schedule its sources again."
        : "Provide the credential, or set `sourceEnabled` false for the sources that want it: an integration nobody intends to run is a configuration decision, not an open issue.",
    });
  }

  // The nightly backup runs on the host, outside this process. Nothing here could see it stop, so
  // a backup that quietly stopped stayed invisible until the day it was needed.
  const backup = backupStatus(config.BACKUP_DIRECTORY, now);
  if (!backup.ok) {
    const seenAt = backup.verifiedAt ?? new Date(now).toISOString();
    issues.push({
      id: "backup:stale",
      kind: "backup_stale",
      severity: backup.state === "stale" ? "error" : "critical",
      entity: "backup",
      firstSeenAt: seenAt,
      updatedAt: new Date(now).toISOString(),
      message: `Backup is not current: ${backup.detail}`,
      hint: "Check the nightly backup job on the host; an archive that has not been verified is not a backup.",
    });
  }

  const severity = { critical: 0, error: 1, warning: 2 } satisfies Record<IssueSeverity, number>;
  sharedCause(issues, health);
  return issues.sort(
    (left, right) =>
      severity[left.severity] - severity[right.severity] || right.updatedAt.localeCompare(left.updatedAt),
  );
}
