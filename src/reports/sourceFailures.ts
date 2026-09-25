import type { Database } from "bun:sqlite";
import { listFailureEvidence } from "../storage/failureEvidence.js";
import { listSourceShapes, shapeDifference } from "../storage/sourceShapes.js";

/**
 * Everything recorded about why one source is failing: the kinds, the sentences, the structure.
 *
 * `flaky` reads a rate and `issues` reads the present state. Neither could answer "which field", and
 * that was the whole gap: `arena` failed 30 of 178 attempts with the words "response did not match
 * the schema (ZodError)" and nothing else, because the body of a failed parse is deliberately never
 * kept. The structure of the complaint is not the body -- a path is a list of field names from the
 * schemas in this repository -- so it can be kept, and this is where it is read.
 *
 * `shapes` is the other half, and the one that needed a live fetch of the page before it existed:
 * the structure of the answers that did work, newest first, with what changed between the two most
 * recent. A path that is gone is the diagnosis for most of the schema failures there are.
 */
export type SourceFailures = {
  source: string;
  days: number;
  attempts: number;
  failures: number;
  kinds: { kind: string; failures: number; firstAt: string; lastAt: string; example: string | null }[];
  evidence: { observedAt: string; kind: string; summary: Record<string, unknown> }[];
  /** Distinct shapes of a successful answer from this source, newest first. Paths and types only. */
  shapes: {
    firstSeenAt: string;
    lastSeenAt: string;
    seen: number;
    paths: number;
    counts: Record<string, { min: number; max: number; last: number }>;
  }[];
  /** What the newest shape has that the one before it did not, and the other way round. */
  shapeChange: { gone: string[]; arrived: string[]; retyped: string[] } | null;
};

export function sourceFailures(db: Database, source: string, days = 7, now = Date.now()): SourceFailures {
  const from = new Date(now - days * 24 * 3_600_000).toISOString();
  const totals = db
    .query<{ attempts: number; failures: number }, [string, string]>(
      "SELECT COUNT(*) AS attempts, SUM(success = 0) AS failures FROM source_collection_metrics WHERE source=? AND collected_at >= ?",
    )
    .get(source, from) ?? { attempts: 0, failures: 0 };
  const kinds = db
    .query<
      { kind: string; failures: number; first_at: string; last_at: string; example: string | null },
      [string, string]
    >(
      `SELECT COALESCE(failure_kind, CASE WHEN error LIKE 'Collection degraded:%' THEN 'degraded' ELSE 'unrecorded' END)
                AS kind,
              COUNT(*) AS failures,
              MIN(collected_at) AS first_at,
              MAX(collected_at) AS last_at,
              MAX(error) AS example
       FROM source_collection_metrics
       WHERE source=? AND collected_at >= ? AND success = 0
       GROUP BY kind
       ORDER BY failures DESC`,
    )
    .all(source, from);
  const shapes = listSourceShapes(db, source);
  const [newest, previous] = shapes;
  return {
    source,
    days,
    attempts: totals.attempts,
    failures: totals.failures ?? 0,
    kinds: kinds.map((row) => ({
      kind: row.kind,
      failures: row.failures,
      firstAt: row.first_at,
      lastAt: row.last_at,
      example: row.example,
    })),
    evidence: listFailureEvidence(db, source).map((entry) => ({
      observedAt: entry.observedAt,
      kind: entry.kind,
      summary: entry.summary,
    })),
    shapes: shapes.map((entry) => ({
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
      seen: entry.seen,
      paths: entry.paths,
      counts: entry.counts,
    })),
    // Only meaningful with two to compare: one shape is a contract that has held.
    shapeChange: newest && previous ? shapeDifference(previous.shape, newest.shape) : null,
  };
}
