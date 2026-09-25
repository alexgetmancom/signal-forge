import type { Database } from "bun:sqlite";

/**
 * How many failures per source are kept. Enough to tell "always like this" from "once", and few
 * enough that a source failing every two minutes for a week cannot grow without bound.
 */
const KEPT_PER_SOURCE = 20;

export type FailureEvidence = {
  source: string;
  observedAt: string;
  kind: string;
  summary: Record<string, unknown>;
};

/**
 * Write down the structure of a failure, and keep only the most recent few per source.
 *
 * The caller owns the transaction. Telemetry must never be the reason a collection cycle fails, so
 * a serialisation that cannot be written is dropped rather than raised.
 */
export function recordFailureEvidence(
  db: Database,
  source: string,
  observedAt: string,
  kind: string,
  summary: Record<string, unknown>,
): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(summary);
  } catch {
    return;
  }
  db.query(
    `INSERT INTO source_failure_evidence(source,observed_at,kind,summary_json) VALUES(?,?,?,?)
     ON CONFLICT(source,observed_at) DO UPDATE SET kind=excluded.kind,summary_json=excluded.summary_json`,
  ).run(source, observedAt, kind, serialized);
  db.query(
    `DELETE FROM source_failure_evidence
     WHERE source=?
       AND observed_at NOT IN (
         SELECT observed_at FROM source_failure_evidence WHERE source=? ORDER BY observed_at DESC LIMIT ?
       )`,
  ).run(source, source, KEPT_PER_SOURCE);
}

export function listFailureEvidence(db: Database, source: string, limit = KEPT_PER_SOURCE): FailureEvidence[] {
  return db
    .query<{ source: string; observed_at: string; kind: string; summary_json: string }, [string, number]>(
      "SELECT source,observed_at,kind,summary_json FROM source_failure_evidence WHERE source=? ORDER BY observed_at DESC LIMIT ?",
    )
    .all(source, limit)
    .map((row) => ({
      source: row.source,
      observedAt: row.observed_at,
      kind: row.kind,
      summary: parseSummary(row.summary_json),
    }));
}

function parseSummary(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
