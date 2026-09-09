import type { Database } from "bun:sqlite";
import { z } from "zod";
import { capabilityReport } from "./capabilities.js";
import type { AppConfig } from "./config.js";
import { requireDeliveryVerification } from "./deliveryVerification.js";
import { listActionableIssues } from "./issues.js";
import { signalQuality } from "./signalQuality.js";
import { sourceJobs } from "./sources/registry.js";
import { listStories } from "./stories.js";

export function operations(db: Database, config: AppConfig) {
  return {
    status: {
      description: "Source health, configured destinations and delivery queue counts.",
      schema: z.object({}),
      handler: () => {
        const capabilities = capabilityReport(db, config);
        return {
          sources: sourceJobs(db, config).map((job) => ({
            id: job.id,
            label: job.label,
            group: job.group,
            stream: job.stream,
            intervalSeconds: job.interval,
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
            .filter((entry) => entry.status === "missing")
            .map((entry) => `${entry.id}: missing`),
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
    events: {
      description: "Recent detected changes, including before and after evidence.",
      schema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      handler: (input: { limit: number }) =>
        db
          .query(
            "SELECT id,source,stream,entity_id,kind,confidence,evidence_type,detected_at FROM events ORDER BY id DESC LIMIT ?",
          )
          .all(input.limit),
    },
    event: {
      description: "Full before/after evidence for one event.",
      schema: z.object({ id: z.number().int().positive() }),
      handler: (input: { id: number }) => db.query("SELECT * FROM events WHERE id=?").get(input.id),
    },
    deliveries: {
      description: "Recent delivery outcomes. Ambiguous sends require checking the destination.",
      schema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      handler: (input: { limit: number }) =>
        db
          .query(
            "SELECT id,batch_id,destination_id,status,attempts,external_id,error,verification_source,verified_at,verification_attempts,last_verification_error FROM deliveries ORDER BY id DESC LIMIT ?",
          )
          .all(input.limit),
    },
    deliveries_needing_verification: {
      description: "Ambiguous or manually unresolved deliveries that must be checked without resending.",
      schema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      handler: (input: { limit: number }) =>
        db
          .query(
            "SELECT id,batch_id,destination_id,status,attempts,external_id,error,verification_attempts,last_verification_error FROM deliveries WHERE status IN ('ambiguous','verification_required') ORDER BY id DESC LIMIT ?",
          )
          .all(input.limit),
    },
    require_delivery_verification: {
      description: "Mark one ambiguous delivery for manual verification; this never sends a second message.",
      schema: z.object({ id: z.number().int().positive() }),
      handler: (input: { id: number }) => requireDeliveryVerification(db, input.id),
    },
    signal_quality: {
      description: "Source collection, event, delivery and suppression metrics for an operator-selected period.",
      schema: z.object({ days: z.number().int().min(1).max(90).default(7) }),
      handler: (input: { days: number }) => signalQuality(db, config, input.days),
    },
    stories: {
      description:
        "Deterministically correlated event stories with confidence, identity state, aliases and immutable evidence IDs.",
      schema: z.object({
        since: z.string().datetime({ offset: true }).optional(),
        minConfidence: z.enum(["observed", "supported", "confirmed", "shipped"]).default("observed"),
        vendor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      handler: (input: {
        since?: string | undefined;
        minConfidence: "observed" | "supported" | "confirmed" | "shipped";
        vendor?: string | undefined;
        limit: number;
      }) => listStories(db, input),
    },
    issues: {
      description: "Current source, delivery, worker, restart and capability problems requiring operator attention.",
      schema: z.object({}),
      handler: (_input: Record<string, never>) => listActionableIssues(db, config),
    },
    capabilities: {
      description: "Sanitized readiness of enabled integrations and intentionally disabled source capabilities.",
      schema: z.object({}),
      handler: (_input: Record<string, never>) => capabilityReport(db, config),
    },
  };
}
