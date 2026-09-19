import type { Database } from "bun:sqlite";
import { capabilityReport } from "../capabilities.js";
import type { AppConfig } from "../config.js";
import { sourceJobs } from "../sources/registry.js";
import { listActionableIssues } from "./issues.js";

/** Source health, configured destinations and delivery queue counts, as the status operation reports them. */
export function statusReport(db: Database, config: AppConfig) {
  const capabilities = capabilityReport(db, config);
  // Prepared once and reused for every source rather than once per source.
  const sourceState = db.query<
    { last_success: string | null; last_error: string | null; checked_at: string | null; retry_at: string | null },
    [string]
  >("SELECT last_success,last_error,checked_at,retry_at FROM sources WHERE id=?");
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
      ...(sourceState.get(job.id) ?? {}),
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
}
