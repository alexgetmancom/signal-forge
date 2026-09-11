import type { Database } from "bun:sqlite";
import type { AppConfig } from "./config.js";
import { prepareDeliveries } from "./events/batching.js";
import { identityFor } from "./events/identity.js";
import {
  type LifecycleReminderContext,
  lifecycleReminderContextSchema,
  renderLifecycleReminderEmbed,
  renderLifecycleReminderText,
} from "./events/render/lifecycle.js";
import type { Event, RecordData } from "./events/types.js";
import { buildSourceRegistry } from "./sources/registry.js";

const REMINDER_OFFSETS = [30, 7, 1] as const;
const DAY_MS = 24 * 3_600_000;
const LIFECYCLE_URLS: Record<string, string> = {
  "openai-deprecations": "https://platform.openai.com/docs/deprecations",
  "anthropic-deprecations": "https://platform.claude.com/docs/en/about-claude/model-deprecations",
  "gemini-deprecations": "https://ai.google.dev/gemini-api/docs/deprecations?hl=en",
  "vertex-deprecations": "https://docs.cloud.google.com/vertex-ai/generative-ai/docs/release-notes",
  "aws-bedrock-lifecycle": "https://docs.aws.amazon.com/en_en/bedrock/latest/userguide/model-lifecycle-legacy.html",
  "azure-foundry-lifecycle":
    "https://learn.microsoft.com/en-us/azure/foundry/concepts/model-lifecycle-retirement?view=azureml-api-2",
  "groq-deprecations": "https://console.groq.com/docs/deprecations",
  "cohere-deprecations": "https://docs.cohere.com/docs/deprecations.md",
  "xai-deprecations": "https://docs.x.ai/developers/migration/may-15-retirement",
};

type LifecycleEvent = Event & { detected_at: string };
type DeadlineCandidate = LifecycleReminderContext & {
  stableKey: string;
  event: LifecycleEvent;
  active: boolean;
  canonicalId: string | null;
  updatedAt: string;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordFor(event: Event): RecordData | null {
  const raw = event.after_json ?? event.before_json;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RecordData;
  } catch {
    return null;
  }
}

function normalizeDate(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T00:00:00.000Z`)
    : /^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/i.test(
          raw,
        )
      ? new Date(`${raw} UTC`)
      : new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function canonicalId(event: Event, record: RecordData | null): string | null {
  const explicit = text(record?.canonical_id) ?? text(record?.canonicalId) ?? text(record?.modelId);
  if (explicit) return explicit;
  return identityFor(event, record).canonicalId;
}

function isRetraction(record: RecordData | null): boolean {
  return record?.retracted === true || /retract|cancel|withdraw/i.test(text(record?.stage) ?? "");
}

function isoDates(value: string): string[] {
  return [
    ...value.matchAll(/\b(20\d{2}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g),
  ].map((match) => match[1] as string);
}

function candidateFor(event: LifecycleEvent, now: number): DeadlineCandidate[] {
  if (event.stream !== "deprecations") return [];
  const record = recordFor(event);
  const url = text(record?.url) ?? LIFECYCLE_URLS[event.source] ?? "https://platform.openai.com/docs/deprecations";
  const common = {
    title: text(record?.name) ?? event.entity_id,
    replacement: text(record?.replacement),
    source: event.source,
    eventId: event.id,
    url,
    event,
    active: event.kind !== "removed" && !isRetraction(record),
    canonicalId: canonicalId(event, record),
    updatedAt: event.detected_at,
  };
  const result: DeadlineCandidate[] = [];
  for (const [field, deadlineType] of [
    ["retirement", "retirement"],
    ["deprecated", "deprecation"],
    ["shutdown", "shutdown"],
  ] as const) {
    const deadline = normalizeDate(record?.[field]);
    if (!deadline) continue;
    result.push({
      ...common,
      stableKey: `${event.source}:${event.entity_id}:${deadlineType}`,
      deadlineType,
      deadlineAt: deadline,
      offsetDays: 30,
    });
  }
  if (result.length) return result;
  if (event.source !== "openai-deprecations") return [];
  const summary = text(record?.summary);
  if (!summary) return [];
  const dates = [...new Set(isoDates(summary))];
  if (dates.length !== 1) return [];
  const deadline = normalizeDate(dates[0]);
  if (!deadline || Date.parse(deadline) <= now) return [];
  result.push({
    ...common,
    stableKey: `${event.source}:${event.entity_id}:deprecation`,
    deadlineType: "deprecation",
    deadlineAt: deadline,
    offsetDays: 30,
  });
  return result;
}

function latestEvents(db: Database): LifecycleEvent[] {
  const rows = db
    .query<LifecycleEvent, []>(
      `SELECT id,source,stream,entity_id,kind,before_json,after_json,detected_at,confidence,evidence_type,authority
       FROM events WHERE stream='deprecations' ORDER BY detected_at,id`,
    )
    .all();
  const latest = new Map<string, LifecycleEvent>();
  for (const event of rows) latest.set(`${event.source}\u0000${event.entity_id}`, event);
  return [...latest.values()].sort(
    (left, right) => Date.parse(left.detected_at) - Date.parse(right.detected_at) || left.id - right.id,
  );
}

function ensureReminders(db: Database, deadlineId: number, deadlineAt: string): void {
  for (const offsetDays of REMINDER_OFFSETS) {
    const dueAt = new Date(Date.parse(deadlineAt) - offsetDays * DAY_MS).toISOString();
    const existing = db
      .query<{ batch_id: number | null }, [number, number]>(
        "SELECT batch_id FROM lifecycle_reminders WHERE deadline_id=? AND offset_days=?",
      )
      .get(deadlineId, offsetDays);
    if (!existing) {
      db.query("INSERT INTO lifecycle_reminders(deadline_id,offset_days,due_at,batch_id) VALUES(?,?,?,NULL)").run(
        deadlineId,
        offsetDays,
        dueAt,
      );
    } else if (existing.batch_id === null) {
      db.query("UPDATE lifecycle_reminders SET due_at=? WHERE deadline_id=? AND offset_days=?").run(
        dueAt,
        deadlineId,
        offsetDays,
      );
    }
  }
}

/** Rebuilds lifecycle deadlines and unsent reminder dates from immutable deprecation evidence. */
export function rebuildLifecycleDeadlines(db: Database, now = Date.now()): void {
  const candidates = latestEvents(db).flatMap((event) => candidateFor(event, now));
  const currentKeys = new Set(candidates.map((candidate) => candidate.stableKey));
  for (const candidate of candidates) {
    const row = db
      .query<
        { id: number },
        [string, number, string | null, string, string, string, string, string | null, number, string]
      >(
        `INSERT INTO lifecycle_deadlines(
           stable_key,event_id,canonical_id,title,source,deadline_type,deadline_at,replacement,active,updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(stable_key) DO UPDATE SET event_id=excluded.event_id,canonical_id=excluded.canonical_id,
           title=excluded.title,source=excluded.source,deadline_type=excluded.deadline_type,deadline_at=excluded.deadline_at,
           replacement=excluded.replacement,active=excluded.active,updated_at=excluded.updated_at
         RETURNING id`,
      )
      .get(
        candidate.stableKey,
        candidate.event.id,
        candidate.canonicalId,
        candidate.title,
        candidate.source,
        candidate.deadlineType,
        candidate.deadlineAt,
        candidate.replacement,
        candidate.active ? 1 : 0,
        candidate.updatedAt,
      );
    if (!row) throw new Error(`Lifecycle deadline ${candidate.stableKey} could not be stored`);
    if (candidate.active) ensureReminders(db, row.id, candidate.deadlineAt);
  }

  const latest = latestEvents(db);
  const latestByEntity = new Map(latest.map((event) => [`${event.source}\u0000${event.entity_id}`, event]));
  const deadlines = db
    .query<{ id: number; stable_key: string; source: string; event_id: number }, []>(
      "SELECT id,stable_key,source,event_id FROM lifecycle_deadlines",
    )
    .all();
  for (const deadline of deadlines) {
    if (currentKeys.has(deadline.stable_key)) continue;
    const prefix = `${deadline.source}:`;
    if (!deadline.stable_key.startsWith(prefix)) continue;
    const remainder = deadline.stable_key.slice(prefix.length);
    const entityId = remainder.slice(0, remainder.lastIndexOf(":"));
    const event = latestByEntity.get(`${deadline.source}\u0000${entityId}`);
    if (!event) continue;
    db.query("UPDATE lifecycle_deadlines SET active=0,event_id=?,updated_at=? WHERE id=? AND active=1").run(
      event.id,
      event.detected_at,
      deadline.id,
    );
  }
}

export type LifecycleDeadlineView = {
  id: number;
  stableKey: string;
  eventId: number;
  canonicalId: string | null;
  title: string;
  source: string;
  deadlineType: "deprecation" | "retirement" | "shutdown";
  deadlineAt: string;
  replacement: string | null;
  active: boolean;
  updatedAt: string;
  reminders: { offsetDays: number; dueAt: string; batchId: number | null }[];
};

function deadlineView(
  db: Database,
  row: {
    id: number;
    stable_key: string;
    event_id: number;
    canonical_id: string | null;
    title: string;
    source: string;
    deadline_type: "deprecation" | "retirement" | "shutdown";
    deadline_at: string;
    replacement: string | null;
    active: number;
    updated_at: string;
  },
): LifecycleDeadlineView {
  const reminders = db
    .query<{ offset_days: number; due_at: string; batch_id: number | null }, [number]>(
      "SELECT offset_days,due_at,batch_id FROM lifecycle_reminders WHERE deadline_id=? ORDER BY offset_days DESC",
    )
    .all(row.id)
    .map((reminder) => ({ offsetDays: reminder.offset_days, dueAt: reminder.due_at, batchId: reminder.batch_id }));
  return {
    id: row.id,
    stableKey: row.stable_key,
    eventId: row.event_id,
    canonicalId: row.canonical_id,
    title: row.title,
    source: row.source,
    deadlineType: row.deadline_type,
    deadlineAt: row.deadline_at,
    replacement: row.replacement,
    active: row.active === 1,
    updatedAt: row.updated_at,
    reminders,
  };
}

export function listLifecycleDeadlines(db: Database, days = 30, now = Date.now()): LifecycleDeadlineView[] {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("Deadline days must be between 1 and 365");
  const until = new Date(now + days * DAY_MS).toISOString();
  return db
    .query<Parameters<typeof deadlineView>[1], [string, string]>(
      "SELECT id,stable_key,event_id,canonical_id,title,source,deadline_type,deadline_at,replacement,active,updated_at FROM lifecycle_deadlines WHERE active=1 AND deadline_at>=? AND deadline_at<=? ORDER BY deadline_at,id",
    )
    .all(new Date(now).toISOString(), until)
    .map((row) => deadlineView(db, row));
}

function eventUrl(event: Event): string {
  const record = recordFor(event);
  return text(record?.url) ?? "https://platform.claude.com/docs/en/about-claude/model-deprecations";
}

/** Creates idempotent lifecycle reminder batches and materializes their normal delivery rows. */
export function scheduleLifecycleReminders(db: Database, config: AppConfig, now = Date.now()): number {
  return db.transaction(() => {
    const destinations = config.destinations.filter((destination) => destination.signals.includes("reminder"));
    if (!destinations.length) return 0;
    const shadowSources = new Set(
      buildSourceRegistry(db, config)
        .filter((source) => source.mode === "shadow")
        .map((source) => source.id),
    );
    const due = db
      .query<
        {
          deadline_id: number;
          offset_days: number;
          event_id: number;
          canonical_id: string | null;
          title: string;
          source: string;
          deadline_type: "deprecation" | "retirement" | "shutdown";
          deadline_at: string;
          replacement: string | null;
        },
        [string, string]
      >(
        `SELECT lr.deadline_id,lr.offset_days,ld.event_id,ld.canonical_id,ld.title,ld.source,
                ld.deadline_type,ld.deadline_at,ld.replacement
         FROM lifecycle_reminders lr
         JOIN lifecycle_deadlines ld ON ld.id=lr.deadline_id
         WHERE ld.active=1 AND lr.batch_id IS NULL AND lr.due_at<=? AND ld.deadline_at>?
         ORDER BY lr.due_at,lr.deadline_id,lr.offset_days`,
      )
      .all(new Date(now).toISOString(), new Date(now).toISOString());
    let batches = 0;
    for (const reminder of due) {
      if (shadowSources.has(reminder.source)) continue;
      const event = db.query<Event, [number]>("SELECT * FROM events WHERE id=?").get(reminder.event_id);
      if (!event) continue;
      const context: LifecycleReminderContext = {
        title: reminder.title,
        deadlineType: reminder.deadline_type,
        deadlineAt: reminder.deadline_at,
        offsetDays: reminder.offset_days,
        replacement: reminder.replacement,
        source: reminder.source,
        eventId: reminder.event_id,
        url: eventUrl(event),
      };
      lifecycleReminderContextSchema.parse(context);
      const batch = db
        .query<{ id: number }, [string, number, number, string]>(
          "INSERT INTO batches(source,digest,ready_at,kind,context_json) VALUES(?,?,?,'lifecycle_reminder',?) RETURNING id",
        )
        .get(reminder.source, 0, now, JSON.stringify(context));
      if (!batch) throw new Error("Lifecycle reminder batch insert failed");
      db.query("INSERT INTO batch_events(batch_id,event_id,url,signal) VALUES(?,?,?,'reminder')").run(
        batch.id,
        event.id,
        context.url,
      );
      for (const destination of destinations)
        db.query("INSERT INTO batch_targets(batch_id,destination_id,destination_json) VALUES(?,?,?)").run(
          batch.id,
          destination.id,
          JSON.stringify(destination),
        );
      db.query(
        "UPDATE lifecycle_reminders SET batch_id=? WHERE deadline_id=? AND offset_days=? AND batch_id IS NULL",
      ).run(batch.id, reminder.deadline_id, reminder.offset_days);
      batches += 1;
    }
    prepareDeliveries(db, now, config.vendorRoles, config.allSignalsRole);
    return batches;
  })();
}

export { renderLifecycleReminderEmbed, renderLifecycleReminderText };
