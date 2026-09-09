import type { Database } from "bun:sqlite";
import type { AppConfig } from "./config.js";
import { hasNotificationContent } from "./events/notification.js";
import type { Event } from "./events/types.js";
import { sourceJobs } from "./sources/registry.js";

export type SignalQualitySource = {
  id: string;
  label: string;
  collections: number;
  successfulCollections: number;
  failedCollections: number;
  recordsProcessed: number;
  eventsCreated: number;
  newEvents: number;
  changedEvents: number;
  removedEvents: number;
  immediateDeliveries: number;
  digestDeliveries: number;
  rolePings: number;
  failedDeliveries: number;
  ambiguousDeliveries: number;
  suppressedEvents: number;
  sourceFailureRate: number;
  averageEventsPerCollection: number;
};

export type SignalQualityReport = {
  since: string;
  days: number;
  sources: SignalQualitySource[];
};

type CollectionAggregate = {
  source: string;
  collections: number;
  successful: number;
  failed: number;
  records: number;
  events: number;
  newEvents: number;
  changedEvents: number;
  removedEvents: number;
};

type DeliveryAggregate = {
  source: string;
  digest: number;
  status: string;
  count: number;
};

type RenderableEvent = Event & { url: string };

const rounded = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/**
 * Summarizes observable signal value for an operator-selected period. Delivery counts are rows
 * created for the source's batches; failed and ambiguous rows stay visible instead of being
 * mistaken for successful reach.
 */
export function signalQuality(db: Database, config: AppConfig, days = 7, now = Date.now()): SignalQualityReport {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("Signal quality days must be between 1 and 90");
  const since = new Date(now - days * 24 * 3_600_000).toISOString();
  const collections = new Map(
    db
      .query<CollectionAggregate, [string]>(
        `SELECT source,
                COUNT(*) AS collections,
                SUM(success) AS successful,
                SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS failed,
                SUM(records_processed) AS records,
                SUM(events_created) AS events,
                SUM(new_events) AS newEvents,
                SUM(changed_events) AS changedEvents,
                SUM(removed_events) AS removedEvents
         FROM source_collection_metrics
         WHERE collected_at>=?
         GROUP BY source`,
      )
      .all(since)
      .map((row) => [row.source, row] as const),
  );
  const deliveries = db
    .query<DeliveryAggregate, [string]>(
      `SELECT b.source,b.digest,d.status,COUNT(*) AS count
       FROM deliveries d
       JOIN batches b ON b.id=d.batch_id
       WHERE EXISTS (
         SELECT 1
         FROM batch_events be
         JOIN events e ON e.id=be.event_id
         WHERE be.batch_id=b.id AND e.detected_at>=?
       )
       GROUP BY b.source,b.digest,d.status`,
    )
    .all(since);
  const deliveryCounts = new Map<string, { immediate: number; digest: number; failed: number; ambiguous: number }>();
  for (const row of deliveries) {
    const counts = deliveryCounts.get(row.source) ?? { immediate: 0, digest: 0, failed: 0, ambiguous: 0 };
    if (row.digest) counts.digest += row.count;
    else counts.immediate += row.count;
    if (row.status === "failed") counts.failed += row.count;
    if (row.status === "ambiguous" || row.status === "verification_required") counts.ambiguous += row.count;
    deliveryCounts.set(row.source, counts);
  }
  const rolePings = new Map<string, number>();
  const deliveryBodies = db
    .query<{ source: string; body: string }, [string]>(
      `SELECT b.source,d.body
       FROM deliveries d
       JOIN batches b ON b.id=d.batch_id
       WHERE EXISTS (
         SELECT 1
         FROM batch_events be
         JOIN events e ON e.id=be.event_id
         WHERE be.batch_id=b.id AND e.detected_at>=?
       )`,
    )
    .all(since);
  for (const delivery of deliveryBodies) {
    try {
      const payload = JSON.parse(delivery.body) as { allowed_mentions?: { roles?: unknown } };
      const roles = payload.allowed_mentions?.roles;
      if (Array.isArray(roles)) {
        const count = roles.filter((role): role is string => typeof role === "string" && role.length > 0).length;
        rolePings.set(delivery.source, (rolePings.get(delivery.source) ?? 0) + count);
      }
    } catch {
      // Telegram bodies are plain text; only Discord JSON payloads can carry role mentions.
    }
  }

  const suppressed = new Map<string, number>();
  const changedEvents = db
    .query<RenderableEvent, [string]>(
      `SELECT e.id,e.source,e.stream,e.entity_id,e.kind,e.before_json,e.after_json,e.detected_at,MIN(be.url) AS url
       FROM events e
       JOIN batch_events be ON be.event_id=e.id
       WHERE e.detected_at>=? AND e.kind='changed'
       GROUP BY e.id`,
    )
    .all(since);
  for (const event of changedEvents) {
    if (!hasNotificationContent(event, event.url))
      suppressed.set(event.source, (suppressed.get(event.source) ?? 0) + 1);
  }

  const sources = sourceJobs(db, config).map<SignalQualitySource>((job) => {
    const row = collections.get(job.id);
    const counts = deliveryCounts.get(job.id) ?? { immediate: 0, digest: 0, failed: 0, ambiguous: 0 };
    const total = row?.collections ?? 0;
    const successful = row?.successful ?? 0;
    return {
      id: job.id,
      label: job.label,
      collections: total,
      successfulCollections: successful,
      failedCollections: row?.failed ?? 0,
      recordsProcessed: row?.records ?? 0,
      eventsCreated: row?.events ?? 0,
      newEvents: row?.newEvents ?? 0,
      changedEvents: row?.changedEvents ?? 0,
      removedEvents: row?.removedEvents ?? 0,
      immediateDeliveries: counts.immediate,
      digestDeliveries: counts.digest,
      rolePings: rolePings.get(job.id) ?? 0,
      failedDeliveries: counts.failed,
      ambiguousDeliveries: counts.ambiguous,
      suppressedEvents: suppressed.get(job.id) ?? 0,
      sourceFailureRate: total ? rounded((row?.failed ?? 0) / total, 3) : 0,
      averageEventsPerCollection: successful ? rounded((row?.events ?? 0) / successful) : 0,
    };
  });
  return { since, days, sources };
}
