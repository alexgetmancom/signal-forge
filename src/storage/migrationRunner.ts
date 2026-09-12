import type { Database } from "bun:sqlite";
import { CURRENT_SCHEMA_VERSION, readMigrations } from "./migrations.js";

function tableExists(db: Database, name: string): boolean {
  return Boolean(
    db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name),
  );
}

function triggerExists(db: Database, name: string): boolean {
  return Boolean(
    db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?").get(name),
  );
}

function columns(db: Database, table: string): Set<string> {
  return new Set(
    db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => column.name),
  );
}

/**
 * Databases created before user_version existed already contain the schema of the day they were
 * made. Adopt the version that shape actually is; every older shape goes through the SQL
 * migrations from version zero.
 *
 * The versions here are written out rather than counted back from the current one: a baseline is a
 * statement about a schema that exists on disk, and expressing it as an offset moved every one of
 * them the next time a migration was added.
 */
function unversionedBaseline(db: Database): number | null {
  const requiredTables = [
    "sources",
    "snapshots",
    "records",
    "change_candidates",
    "events",
    "batches",
    "batch_events",
    "batch_targets",
    "deliveries",
    "app_state",
    "summaries",
    "http_cache",
  ];
  if (!requiredTables.every((table) => tableExists(db, table))) return null;
  const sourceColumns = columns(db, "sources");
  const deliveryColumns = columns(db, "deliveries");
  const eventColumns = columns(db, "events");
  if (
    sourceColumns.has("failures") &&
    sourceColumns.has("retry_at") &&
    deliveryColumns.has("batch_id") &&
    !deliveryColumns.has("event_id")
  ) {
    if (
      (!deliveryColumns.has("confirmation_source") || !deliveryColumns.has("reconcile_attempts")) &&
      (!deliveryColumns.has("verification_source") || !deliveryColumns.has("verification_attempts"))
    )
      return 3;
    if (!tableExists(db, "source_collection_metrics")) return 4;
    if (!eventColumns.has("confidence")) return 5;
    if (!eventColumns.has("evidence_type")) return tableExists(db, "stories") ? 7 : 6;
    const batchColumns = columns(db, "batches");
    if (
      eventColumns.has("authority") &&
      batchColumns.has("kind") &&
      batchColumns.has("context_json") &&
      tableExists(db, "model_facts") &&
      tableExists(db, "hypotheses") &&
      tableExists(db, "lifecycle_deadlines")
    ) {
      const recordColumns = columns(db, "records");
      if (recordColumns.has("stream") && recordColumns.has("observed_at")) {
        if (!columns(db, "batch_events").has("signal")) return 17;
        if (!tableExists(db, "suppressions")) return 18;
        if (!columns(db, "snapshots").has("body")) return 19;
        // The shapes after 20 are a trigger, two tables and a column, in the order they arrived.
        if (!triggerExists(db, "events_detected_at_shape_insert")) return 20;
        if (!tableExists(db, "credential_circuits")) return 21;
        if (!tableExists(db, "operator_journal")) return 22;
        return sourceColumns.has("failure_started_at") ? 24 : 23;
      }
      if (tableExists(db, "alert_attempts")) return 16;
      if (tableExists(db, "deepseek_usage")) return 15;
      return tableExists(db, "code_metrics") ? 14 : 13;
    }
    const currentVerificationNames = deliveryColumns.has("verification_source");
    const baseline = tableExists(db, "stories") ? (currentVerificationNames ? 9 : 8) : currentVerificationNames ? 8 : 7;
    return eventColumns.has("authority") ? 10 : baseline;
  }
  return null;
}

function schemaVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
}

export function runMigrations(db: Database): void {
  const migrations = readMigrations();
  let version = schemaVersion(db);
  if (version > CURRENT_SCHEMA_VERSION)
    throw new Error(`Database schema version ${version} is newer than ${CURRENT_SCHEMA_VERSION}`);
  if (version === 0) {
    const baseline = unversionedBaseline(db);
    if (baseline !== null) {
      db.exec(`PRAGMA user_version = ${baseline}`);
      version = baseline;
    }
  }

  for (const migration of migrations.filter((candidate) => candidate.version > version)) {
    db.transaction(() => {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    })();
    version = migration.version;
  }
  if (version !== CURRENT_SCHEMA_VERSION)
    throw new Error(`Database schema stopped at ${version}, expected ${CURRENT_SCHEMA_VERSION}`);
}
