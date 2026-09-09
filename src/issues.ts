import type { Database } from "bun:sqlite";
import { capabilityReport } from "./capabilities.js";
import type { AppConfig } from "./config.js";
import { sourceHealth } from "./status.js";

export type IssueKind =
  | "source_failed"
  | "collection_degraded"
  | "delivery_failed"
  | "delivery_ambiguous"
  | "worker_failed"
  | "restart_loop"
  | "capability_missing";
export type IssueSeverity = "warning" | "error" | "critical";

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
};

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
  for (const entry of health) {
    const rateLimited = entry.state === "blocked" && entry.detail.startsWith("rate limited");
    if (!(entry.state === "failing" || entry.state === "stale" || entry.state === "degraded" || rateLimited)) continue;
    const checked = db
      .query<{ checked_at: string | null }, [string]>("SELECT checked_at FROM sources WHERE id=?")
      .get(entry.id)?.checked_at;
    issues.push({
      id: entry.id,
      kind: entry.state === "degraded" ? "collection_degraded" : "source_failed",
      severity: rateLimited ? "warning" : entry.state === "degraded" ? "critical" : "error",
      entity: entry.id,
      source: entry.id,
      firstSeenAt: issueTime(checked, now),
      updatedAt: issueTime(checked, now),
      message: `${entry.label} ${
        entry.state === "stale"
          ? "is stale"
          : entry.state === "degraded"
            ? "returned a suspiciously smaller collection"
            : "is not collecting successfully"
      }: ${entry.detail}`,
      hint: rateLimited
        ? "Wait for the upstream limit to clear; do not increase polling."
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

  const workerRows = db
    .query<{ key: string; value: string }, []>("SELECT key,value FROM app_state WHERE key LIKE 'worker:%'")
    .all();
  for (const row of workerRows) {
    const state = readJson<WorkerState>(row.value, {});
    if (state.state !== "failed") continue;
    const worker = row.key.slice("worker:".length);
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
    if (capability.status !== "missing") continue;
    const timestamp = new Date(now).toISOString();
    issues.push({
      id: `capability:${capability.id}`,
      kind: "capability_missing",
      severity: "error",
      entity: capability.id,
      firstSeenAt: timestamp,
      updatedAt: timestamp,
      message: `Capability ${capability.id} is missing ${capability.missingCount} required credential${capability.missingCount === 1 ? "" : "s"}`,
      hint: "Provide the credential for an intentionally enabled integration, then restart the service.",
    });
  }

  const severity = { critical: 0, error: 1, warning: 2 } satisfies Record<IssueSeverity, number>;
  return issues.sort(
    (left, right) =>
      severity[left.severity] - severity[right.severity] || right.updatedAt.localeCompare(left.updatedAt),
  );
}
