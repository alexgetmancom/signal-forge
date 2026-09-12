import type { Database } from "bun:sqlite";
import { capabilityReport } from "./capabilities.js";
import type { AppConfig } from "./config.js";
import { backupStatus } from "./doctor.js";
import { sourceHealth } from "./status.js";
import { databaseSize } from "./storage/retention.js";

/** Where growth stops being normal and becomes something to look at, rather than to discover. */
const DATABASE_SIZE_BUDGET = 5 * 1024 ** 3;

function gigabytes(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

export type IssueKind =
  | "source_failed"
  | "collection_degraded"
  | "delivery_failed"
  | "delivery_ambiguous"
  | "delivery_stuck"
  | "worker_failed"
  | "worker_stale"
  | "restart_loop"
  | "capability_missing"
  | "capability_rejected"
  | "backup_stale"
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

/** The single read model for failures that require the owner's attention right now. */
export function listActionableIssues(db: Database, config: AppConfig, now = Date.now()): ActionableIssue[] {
  const issues: ActionableIssue[] = [];
  const health = sourceHealth(db, config, now);
  const sourceWorker = db.query<{ value: string }, []>("SELECT value FROM app_state WHERE key='worker:sources'").get();
  const sourceWorkerState = sourceWorker ? readJson<WorkerState>(sourceWorker.value, {}) : {};
  const sourceCycleFinished = sourceWorkerState.state === "idle" && Boolean(sourceWorkerState.lastFinishedAt);
  for (const entry of health) {
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
      .query<{ checked_at: string | null; failure_started_at: string | null }, [string]>(
        "SELECT checked_at,failure_started_at FROM sources WHERE id=?",
      )
      .get(entry.id);
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
            ? "Inspect the upstream response before allowing this source to resume; the last known-good records were preserved."
            : "Inspect the collector and its upstream response.",
    });
  }

  const deliveries = db
    .query<
      {
        id: number;
        destination_id: string;
        status: "failed" | "ambiguous" | "verification_required";
        updated_at: number;
        error: string | null;
      },
      []
    >(
      "SELECT id,destination_id,status,updated_at,error FROM deliveries WHERE status IN ('failed','ambiguous','verification_required') ORDER BY id",
    )
    .all();
  for (const delivery of deliveries) {
    const updatedAt = issueTime(new Date(delivery.updated_at).toISOString(), now);
    const ambiguous = delivery.status !== "failed";
    issues.push({
      id: `delivery:${delivery.id}`,
      kind: ambiguous ? "delivery_ambiguous" : "delivery_failed",
      severity: ambiguous ? "critical" : "error",
      entity: String(delivery.id),
      destination: delivery.destination_id,
      firstSeenAt: updatedAt,
      updatedAt,
      message: `Delivery ${delivery.id} to ${delivery.destination_id} is ${delivery.status}`,
      hint: ambiguous
        ? "Verify the destination before any retry; the send may already have reached the audience."
        : "Inspect the stored platform response and destination configuration.",
    });
  }

  const stuckDeliveries = db
    .query<{ id: number; destination_id: string; updated_at: number }, [number]>(
      "SELECT id,destination_id,updated_at FROM deliveries WHERE status='sending' AND updated_at<? ORDER BY updated_at",
    )
    .all(now - STUCK_DELIVERY_MS);
  for (const delivery of stuckDeliveries) {
    const updatedAt = issueTime(new Date(delivery.updated_at).toISOString(), now);
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

  const runtime = db.query<{ value: string }, []>("SELECT value FROM app_state WHERE key='runtime'").get();
  const runtimeState = runtime ? readJson<{ uncleanRestarts?: string[] }>(runtime.value, {}) : {};
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

  for (const capability of capabilityReport(db, config)) {
    if (capability.status !== "missing" && capability.status !== "rejected") continue;
    const timestamp = new Date(now).toISOString();
    const rejected = capability.status === "rejected";
    issues.push({
      id: `capability:${capability.id}`,
      kind: rejected ? "capability_rejected" : "capability_missing",
      severity: "error",
      entity: capability.id,
      firstSeenAt: timestamp,
      updatedAt: timestamp,
      message: rejected
        ? `Capability ${capability.id} was refused by its upstream; ${capability.enabledSources.length} source${capability.enabledSources.length === 1 ? " is" : "s are"} not being collected`
        : `Capability ${capability.id} is missing ${capability.missingCount} required credential${capability.missingCount === 1 ? "" : "s"}`,
      hint: rejected
        ? "Rotate the credential and restart the service, then clear-credential-circuit to schedule its sources again."
        : "Provide the credential for an intentionally enabled integration, then restart the service.",
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
  return issues.sort(
    (left, right) =>
      severity[left.severity] - severity[right.severity] || right.updatedAt.localeCompare(left.updatedAt),
  );
}
