import type { Database } from "bun:sqlite";

/**
 * Rows that satisfy the schema's CHECK constraints by construction.
 *
 * Every table a test reaches for carries an enumeration -- `authority`, `confidence`,
 * `evidence_type`, `kind`, the ISO-8601 shape of every `_at` -- and an event needs a snapshot to
 * point at. Written out by hand each time, this produces `CHECK constraint failed` rather than a
 * test, five separate times over two sessions of writing tests here. The defaults below are a valid
 * row of each kind; pass only the field the test is actually about.
 *
 * These build rows directly rather than going through the pipeline, which is the point: a report
 * under test wants a shaped row, not a collection, and the pipeline's own tests cover the pipeline.
 */

let clock = Date.parse("2026-09-20T00:00:00.000Z");

/** A distinct valid instant per call, so rows made in a loop order the way they were written. */
export function anInstant(offsetMs = 60_000): string {
  clock += offsetMs;
  return new Date(clock).toISOString();
}

export function aSnapshot(db: Database, overrides: { source?: string; collectedAt?: string } = {}): number {
  const row = db
    .query<{ id: number }, [string, string]>(
      "INSERT INTO snapshots(source,collected_at,hash,bytes) VALUES(?,?,'',0) RETURNING id",
    )
    .get(overrides.source ?? "arena", overrides.collectedAt ?? anInstant());
  if (!row) throw new Error("Snapshot could not be stored");
  return row.id;
}

export type EventFields = {
  source?: string;
  stream?: string;
  entityId?: string;
  kind?: "new" | "changed" | "removed";
  afterJson?: string | null;
  beforeJson?: string | null;
  detectedAt?: string;
  snapshotId?: number;
  confidence?: "observed" | "supported" | "confirmed" | "shipped";
  evidenceType?: "arena_roster" | "leaderboard" | "official_news" | "api_catalogue" | "unknown";
  authority?: "first_party" | "vendor_owned" | "third_party";
};

export function anEvent(db: Database, fields: EventFields = {}): number {
  const source = fields.source ?? "arena";
  const detectedAt = fields.detectedAt ?? anInstant();
  const snapshotId = fields.snapshotId ?? aSnapshot(db, { source, collectedAt: detectedAt });
  const row = db
    .query<{ id: number }, (string | number | null)[]>(
      `INSERT INTO events(source,stream,entity_id,kind,before_json,after_json,detected_at,snapshot_id,
         confidence,evidence_type,authority)
       VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    )
    .get(
      source,
      fields.stream ?? "arena",
      fields.entityId ?? "model-1",
      fields.kind ?? "new",
      fields.beforeJson ?? null,
      fields.afterJson ?? JSON.stringify({ id: "model-1", name: "Model One" }),
      detectedAt,
      snapshotId,
      fields.confidence ?? "observed",
      fields.evidenceType ?? "arena_roster",
      fields.authority ?? "third_party",
    );
  if (!row) throw new Error("Event could not be stored");
  return row.id;
}

/** One collection attempt as the poller records it: success, or a failure with its kind. */
export function anAttempt(
  db: Database,
  source: string,
  outcome: { error: string; kind: string } | null,
  at = anInstant(),
): void {
  db.query(
    "INSERT INTO source_collection_metrics(source,collected_at,success,error,failure_kind) VALUES(?,?,?,?,?)",
  ).run(source, at, outcome ? 0 : 1, outcome?.error ?? null, outcome?.kind ?? null);
}

/** One journalled call, which is what `usage` reads. */
export function aCall(
  db: Database,
  fields: { operation: string; input?: unknown; surface?: string; outcome?: string; at?: string },
): void {
  db.query(
    "INSERT INTO operator_journal(recorded_at,surface,operation,input_json,outcome,mutates) VALUES(?,?,?,?,?,0)",
  ).run(
    fields.at ?? anInstant(),
    fields.surface ?? "cli",
    fields.operation,
    JSON.stringify(fields.input ?? {}),
    fields.outcome ?? "ok",
  );
}
