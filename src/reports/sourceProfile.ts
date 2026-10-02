import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config.js";
import { buildSourceRegistry, type SourceDefinition } from "../sources/registry.js";

/**
 * Everything this service knows about one source, in one answer.
 *
 * A source is described in code (the registry), remembered in a row (`sources`), and then spread
 * over five more places that are keyed by its name and nothing else: what it collected and when,
 * what it emitted, what it stores now, the last payload, and what of it was ever sent anywhere. Each
 * has a command, and each of those answers a question about every source at once. Asking about one
 * -- why is `pages:openai` silent, what does `models-dev` cost, did the retired boards ever say
 * anything -- meant running five of them and reading a hundred and fifty rows past the one wanted.
 *
 * A retired source is a first-class answer rather than an error. It is the one case where the
 * registry says nothing and the table still holds a history, and `registered: false` with a
 * `retiredAt` is the shortest honest description of it.
 *
 * Nothing here reads an upstream value: counts, instants, kinds and sizes. The sentence on a failing
 * source is the one `issues` and `silent-sources` already print; `failures <source>` has the rest.
 */
export type SourceProfile = {
  source: string;
  /** The registry names it. False for a source that ran once and has since been taken out. */
  registered: boolean;
  retiredAt: string | null;
  definition: SourceDeclaration | null;
  state: SourceState | null;
  records: { count: number; missing: number; newestObservedAt: string | null };
  events: { total: number; lastDetectedAt: string | null; inWindow: Record<"new" | "changed" | "removed", number> };
  collections: {
    attempts: number;
    failures: number;
    failureKinds: Record<string, number>;
    latest: {
      at: string;
      ok: boolean;
      records: number;
      events: number;
      failureKind: string | null;
      peakMb: number | null;
    }[];
  };
  latestSnapshot: { id: number; collectedAt: string; bytes: number; bodyKept: boolean } | null;
  /** Cards that reached a channel and were built from this source's events within the window. */
  sentInWindow: number;
  windowDays: number;
};

/** What the registry declares, less the collector itself. */
type SourceDeclaration = Pick<
  SourceDefinition,
  | "label"
  | "vendor"
  | "kind"
  | "group"
  | "stream"
  | "authority"
  | "evidence"
  | "confidence"
  | "appendOnly"
  | "intervalSeconds"
  | "upstream"
  | "pace"
  | "capabilityId"
  | "enabled"
  | "mode"
  | "heavy"
  | "restrictedReason"
> & { waitingOn: string[] };

type SourceState = {
  firstObservedAt: string | null;
  checkedAt: string | null;
  lastSuccess: string | null;
  lastError: string | null;
  lastErrorKind: string | null;
  failures: number;
  failureStartedAt: string | null;
  retryAt: string | null;
  acceptShrink: boolean;
};

type StateRow = {
  first_observed_at: string | null;
  checked_at: string | null;
  last_success: string | null;
  last_error: string | null;
  last_error_kind: string | null;
  failures: number;
  failure_started_at: string | null;
  retry_at: string | null;
  accept_shrink: number;
  retired_at: string | null;
};

const LATEST_COLLECTIONS = 5;

/** Every name this deployment could be asked about: the registry's, and the table's retired ones. */
export function knownSourceIds(db: Database, config: AppConfig): string[] {
  const registered = buildSourceRegistry(db, config).map((definition) => definition.id);
  const remembered = db.query<{ id: string }, []>("SELECT id FROM sources ORDER BY id").all();
  return [...new Set([...registered, ...remembered.map((row) => row.id)])];
}

export function sourceProfile(
  db: Database,
  config: AppConfig,
  source: string,
  days: number,
  now = new Date(),
): SourceProfile | null {
  const definition = buildSourceRegistry(db, config).find((candidate) => candidate.id === source);
  const row = db
    .query<StateRow, [string]>(
      "SELECT first_observed_at,checked_at,last_success,last_error,last_error_kind,failures,failure_started_at,retry_at,accept_shrink,retired_at FROM sources WHERE id=?",
    )
    .get(source);
  if (!definition && !row) return null;
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  return {
    source,
    registered: Boolean(definition),
    retiredAt: row?.retired_at ?? null,
    definition: definition ? declaration(definition, config) : null,
    state: row ? stateOf(row) : null,
    records: recordsOf(db, source),
    events: eventsOf(db, source, since),
    collections: collectionsOf(db, source, since),
    latestSnapshot: snapshotOf(db, source),
    sentInWindow: sentOf(db, source, since),
    windowDays: days,
  };
}

function declaration(definition: SourceDefinition, config: AppConfig): SourceDeclaration {
  const { vendor, kind, appendOnly, upstream, pace, capabilityId, heavy, restrictedReason } = definition;
  // Optional fields are carried only when set: under exactOptionalPropertyTypes an absent field and
  // an `undefined` one are different types, and the second is not what the registry declared.
  return {
    label: definition.label,
    group: definition.group,
    stream: definition.stream,
    authority: definition.authority,
    evidence: definition.evidence,
    confidence: definition.confidence,
    intervalSeconds: definition.intervalSeconds,
    enabled: definition.enabled,
    mode: definition.mode,
    ...(vendor ? { vendor } : {}),
    ...(kind ? { kind } : {}),
    ...(appendOnly !== undefined ? { appendOnly } : {}),
    ...(upstream ? { upstream } : {}),
    ...(pace ? { pace } : {}),
    ...(capabilityId ? { capabilityId } : {}),
    ...(heavy ? { heavy } : {}),
    ...(restrictedReason ? { restrictedReason } : {}),
    // The credentials it is waiting on, which is the whole reason a registered source is never polled.
    waitingOn: (definition.requiredCapabilities ?? []).filter((name) => !config[name]),
  };
}

function stateOf(row: StateRow): SourceState {
  return {
    firstObservedAt: row.first_observed_at,
    checkedAt: row.checked_at,
    lastSuccess: row.last_success,
    lastError: row.last_error,
    lastErrorKind: row.last_error_kind,
    failures: row.failures,
    failureStartedAt: row.failure_started_at,
    retryAt: row.retry_at,
    acceptShrink: Boolean(row.accept_shrink),
  };
}

function recordsOf(db: Database, source: string): SourceProfile["records"] {
  const row = db
    .query<{ n: number; missing: number | null; newest: string | null }, [string]>(
      "SELECT COUNT(*) n, SUM(missing_count>0) missing, MAX(observed_at) newest FROM records WHERE source=?",
    )
    .get(source);
  return { count: row?.n ?? 0, missing: row?.missing ?? 0, newestObservedAt: row?.newest ?? null };
}

function eventsOf(db: Database, source: string, since: string): SourceProfile["events"] {
  const all = db
    .query<{ n: number; last: string | null }, [string]>(
      "SELECT COUNT(*) n, MAX(detected_at) last FROM events WHERE source=?",
    )
    .get(source);
  const inWindow = { new: 0, changed: 0, removed: 0 };
  for (const row of db
    .query<{ kind: keyof typeof inWindow; n: number }, [string, string]>(
      "SELECT kind, COUNT(*) n FROM events WHERE source=? AND detected_at>=? GROUP BY kind",
    )
    .all(source, since))
    inWindow[row.kind] = row.n;
  return { total: all?.n ?? 0, lastDetectedAt: all?.last ?? null, inWindow };
}

function collectionsOf(db: Database, source: string, since: string): SourceProfile["collections"] {
  const window = db
    .query<{ attempts: number; failures: number | null }, [string, string]>(
      "SELECT COUNT(*) attempts, SUM(success=0) failures FROM source_collection_metrics WHERE source=? AND collected_at>=?",
    )
    .get(source, since);
  const failureKinds: Record<string, number> = {};
  for (const row of db
    .query<{ kind: string | null; n: number }, [string, string]>(
      "SELECT failure_kind kind, COUNT(*) n FROM source_collection_metrics WHERE source=? AND collected_at>=? AND success=0 GROUP BY failure_kind",
    )
    .all(source, since))
    failureKinds[row.kind ?? "unclassified"] = row.n;
  const latest = db
    .query<
      {
        collected_at: string;
        success: number;
        records_processed: number;
        events_created: number;
        failure_kind: string | null;
        peak_rss_mb: number | null;
      },
      [string, number]
    >(
      "SELECT collected_at,success,records_processed,events_created,failure_kind,peak_rss_mb FROM source_collection_metrics WHERE source=? ORDER BY collected_at DESC LIMIT ?",
    )
    .all(source, LATEST_COLLECTIONS)
    .map((row) => ({
      at: row.collected_at,
      ok: row.success === 1,
      records: row.records_processed,
      events: row.events_created,
      failureKind: row.failure_kind,
      peakMb: row.peak_rss_mb,
    }));
  return { attempts: window?.attempts ?? 0, failures: window?.failures ?? 0, failureKinds, latest };
}

function snapshotOf(db: Database, source: string): SourceProfile["latestSnapshot"] {
  const row = db
    .query<{ id: number; collected_at: string; bytes: number; kept: number }, [string]>(
      "SELECT id,collected_at,bytes,body IS NOT NULL AS kept FROM snapshots WHERE source=? ORDER BY id DESC LIMIT 1",
    )
    .get(source);
  return row ? { id: row.id, collectedAt: row.collected_at, bytes: row.bytes, bodyKept: row.kept === 1 } : null;
}

function sentOf(db: Database, source: string, since: string): number {
  return (
    db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(DISTINCT d.id) n
         FROM events e JOIN delivery_events de ON de.event_id=e.id JOIN deliveries d ON d.id=de.delivery_id
         WHERE e.source=? AND e.detected_at>=? AND d.status='sent'`,
      )
      .get(source, since)?.n ?? 0
  );
}
