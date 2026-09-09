import type { Database } from "bun:sqlite";
import type { AppConfig, SourceMode } from "./config.js";
import { CONFIDENCE_LEVELS } from "./events/confidence.js";
import { hasNotificationContent } from "./events/notification.js";
import { sourceFamily } from "./events/sourceFamily.js";
import type { Event } from "./events/types.js";
import { sourceJobs } from "./sources/registry.js";

export type SignalQualitySource = {
  id: string;
  label: string;
  mode: SourceMode;
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
  storyCount: number;
  uniqueStoryCount: number;
  corroboratedStoryCount: number;
  duplicateRate: number;
  freshnessHours: number | null;
  signalDensity: number;
  firstSourceWins: number;
  laterConfirmed: number;
  confirmationRate: number;
  medianLeadTimeSeconds: number | null;
};

export type SignalQualityReport = {
  since: string;
  days: number;
  coverage: {
    requestedSince: string;
    observedFrom: string | null;
    observedUntil: string | null;
    observedHours: number;
  };
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

type StoryAggregate = { source: string; story_id: number | null; event_id: number };

type RenderableEvent = Event & { url: string };
type LeadTime = { source: string; leadTimeSeconds: number };

const rounded = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? null)
    : Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

/**
 * Summarizes observable signal value for an operator-selected period. Delivery counts are rows
 * created for the source's batches; failed and ambiguous rows stay visible instead of being
 * mistaken for successful reach.
 */
export function signalQuality(db: Database, config: AppConfig, days = 7, now = Date.now()): SignalQualityReport {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("Signal quality days must be between 1 and 90");
  const since = new Date(now - days * 24 * 3_600_000).toISOString();
  const bounds = db
    .query<{ observedFrom: string | null; observedUntil: string | null }, [string]>(
      "SELECT MIN(collected_at) AS observedFrom,MAX(collected_at) AS observedUntil FROM source_collection_metrics WHERE collected_at>=?",
    )
    .get(since);
  const observedHours =
    bounds?.observedFrom && bounds.observedUntil
      ? rounded(Math.max(0, Date.parse(bounds.observedUntil) - Date.parse(bounds.observedFrom)) / 3_600_000)
      : 0;
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
      `SELECT e.source,b.digest,d.status,COUNT(DISTINCT d.id) AS count
       FROM deliveries d
       JOIN batches b ON b.id=d.batch_id
       JOIN batch_events be ON be.batch_id=b.id
       JOIN events e ON e.id=be.event_id
       JOIN json_each(d.destination_json, '$.streams') AS subscribed ON subscribed.value=e.stream
       WHERE EXISTS (
         SELECT 1
         FROM batch_events be
         JOIN events e ON e.id=be.event_id
         WHERE be.batch_id=b.id AND e.detected_at>=?
       )
       GROUP BY e.source,b.digest,d.status`,
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
      `SELECT DISTINCT e.source,d.body
       FROM deliveries d
       JOIN batches b ON b.id=d.batch_id
       JOIN batch_events be ON be.batch_id=b.id
       JOIN events e ON e.id=be.event_id
       JOIN json_each(d.destination_json, '$.streams') AS subscribed ON subscribed.value=e.stream
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

  const storyRows = db
    .query<StoryAggregate, [string]>(
      `SELECT e.source,se.story_id,e.id AS event_id
       FROM events e
       LEFT JOIN story_events se ON se.event_id=e.id
       WHERE e.detected_at>=?`,
    )
    .all(since);
  const storySources = new Map<string, Set<string>>();
  const sourceStories = new Map<string, Set<string>>();
  for (const row of storyRows) {
    const key = row.story_id === null ? `event:${row.event_id}` : `story:${row.story_id}`;
    const sources = storySources.get(key) ?? new Set<string>();
    sources.add(row.source);
    storySources.set(key, sources);
    const stories = sourceStories.get(row.source) ?? new Set<string>();
    stories.add(key);
    sourceStories.set(row.source, stories);
  }
  const freshness = new Map(
    db
      .query<{ source: string; latest: string | null }, [string]>(
        "SELECT source,MAX(collected_at) AS latest FROM source_collection_metrics WHERE collected_at<=? AND success=1 GROUP BY source",
      )
      .all(new Date(now).toISOString())
      .map((row) => [row.source, row.latest] as const),
  );

  const firstSourceWins = new Map<string, number>();
  const laterConfirmed = new Map<string, number>();
  const leadTimes: LeadTime[] = [];
  const firstSeenStories = db
    .query<{ id: number }, [string, string]>(
      "SELECT id FROM stories WHERE first_seen_at>=? AND first_seen_at<=? ORDER BY first_seen_at,id",
    )
    .all(since, new Date(now).toISOString());
  for (const story of firstSeenStories) {
    const events = db
      .query<Event & { confidence: NonNullable<Event["confidence"]> }, [number]>(
        `SELECT e.id,e.source,e.stream,e.entity_id,e.kind,e.before_json,e.after_json,e.detected_at,
                e.confidence,e.evidence_type,e.authority
         FROM story_events se JOIN events e ON e.id=se.event_id
         WHERE se.story_id=? ORDER BY e.detected_at,e.id`,
      )
      .all(story.id);
    const first = events[0];
    if (!first) continue;
    firstSourceWins.set(first.source, (firstSourceWins.get(first.source) ?? 0) + 1);
    const firstFamily = sourceFamily(first.source, first.stream);
    const confirming = events
      .slice(1)
      .find(
        (event) =>
          CONFIDENCE_LEVELS.indexOf(event.confidence) >= CONFIDENCE_LEVELS.indexOf("confirmed") &&
          sourceFamily(event.source, event.stream) !== firstFamily,
      );
    if (!confirming) continue;
    const firstAt = Date.parse(first.detected_at);
    const confirmingAt = Date.parse(confirming.detected_at);
    if (!Number.isFinite(firstAt) || !Number.isFinite(confirmingAt)) continue;
    const leadTimeSeconds = Math.max(0, Math.floor((confirmingAt - firstAt) / 1000));
    laterConfirmed.set(first.source, (laterConfirmed.get(first.source) ?? 0) + 1);
    leadTimes.push({ source: first.source, leadTimeSeconds });
  }

  const suppressed = new Map<string, number>();
  const changedEvents = db
    .query<RenderableEvent, [string]>(
      `SELECT e.id,e.source,e.stream,e.entity_id,e.kind,e.before_json,e.after_json,e.detected_at,e.evidence_type,MIN(be.url) AS url
       FROM events e
       JOIN batch_events be ON be.event_id=e.id
       WHERE e.detected_at>=?
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
    const storyKeys = sourceStories.get(job.id) ?? new Set<string>();
    const uniqueStoryCount = [...storyKeys].filter((key) => (storySources.get(key)?.size ?? 0) === 1).length;
    const corroboratedStoryCount = [...storyKeys].filter((key) => (storySources.get(key)?.size ?? 0) > 1).length;
    const latest = freshness.get(job.id);
    return {
      id: job.id,
      label: job.label,
      mode: job.mode,
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
      storyCount: storyKeys.size,
      uniqueStoryCount,
      corroboratedStoryCount,
      duplicateRate: storyKeys.size ? rounded((storyKeys.size - uniqueStoryCount) / storyKeys.size, 3) : 0,
      freshnessHours: latest ? rounded(Math.max(0, now - Date.parse(latest)) / 3_600_000) : null,
      signalDensity: row?.records ? rounded((row.events ?? 0) / row.records, 3) : 0,
      firstSourceWins: firstSourceWins.get(job.id) ?? 0,
      laterConfirmed: laterConfirmed.get(job.id) ?? 0,
      confirmationRate: firstSourceWins.get(job.id)
        ? rounded((laterConfirmed.get(job.id) ?? 0) / (firstSourceWins.get(job.id) ?? 1), 3)
        : 0,
      medianLeadTimeSeconds: median(
        leadTimes.filter((leadTime) => leadTime.source === job.id).map((leadTime) => leadTime.leadTimeSeconds),
      ),
    };
  });
  return {
    since,
    days,
    coverage: {
      requestedSince: since,
      observedFrom: bounds?.observedFrom ?? null,
      observedUntil: bounds?.observedUntil ?? null,
      observedHours,
    },
    sources,
  };
}
