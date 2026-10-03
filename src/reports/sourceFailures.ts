import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config.js";
import { buildSourceRegistry } from "../sources/registry.js";
import { collectionWindowFrom, dayFrom } from "../storage/collectionDays.js";
import { listFailureEvidence } from "../storage/failureEvidence.js";
import { listSourceShapes, shapeDifference } from "../storage/sourceShapes.js";
import { FAILURE_KIND } from "./failureKind.js";

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
  /**
   * Whether the registry still asks for this source.
   *
   * A name typed at this command is any string, and `sources` keeps a row for everything that has
   * ever run. Asking about `designarena:logo` returned a wall of failures ending on 2026-09-09 and
   * said nothing about why they stop: the board was retired the next day. A report that cannot say
   * "this is not being collected any more" is a report that reads as a broken collector.
   */
  registered: boolean;
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

export function sourceFailures(
  db: Database,
  config: AppConfig,
  source: string,
  days = 7,
  now = Date.now(),
): SourceFailures {
  // Whole days: the counts come from the fold, and the example sentence is then looked for over the
  // same bound rather than over a window the counts did not use.
  const from = collectionWindowFrom(days, now);
  const totals = db
    .query<{ attempts: number; failures: number }, [string, string]>(
      `SELECT SUM(attempts) AS attempts,
              SUM(CASE WHEN outcome = 'success' THEN 0 ELSE attempts END) AS failures
       FROM source_collection_days WHERE source=? AND day >= ?`,
    )
    .get(source, dayFrom(from)) ?? { attempts: 0, failures: 0 };
  const kinds = db
    .query<
      { kind: string; failures: number; first_at: string; last_at: string; example: string | null },
      [string, string, string]
    >(
      `SELECT d.outcome AS kind,
              SUM(d.attempts) AS failures,
              MIN(d.first_at) AS first_at,
              MAX(d.last_at) AS last_at,
              -- The sentence itself, from the raw attempts the fold does not carry one into. A kind
              -- whose last occurrence is older than those rows reach keeps its count and loses its
              -- example, which is the honest shape of "it happened, and the wording is gone".
              (SELECT MAX(m.error) FROM source_collection_metrics m
                WHERE m.source = d.source AND m.success = 0 AND ${FAILURE_KIND} = d.outcome
                  AND m.collected_at >= ?) AS example
       FROM source_collection_days d
       WHERE d.source=? AND d.day >= ? AND d.outcome <> 'success'
       GROUP BY kind
       ORDER BY failures DESC`,
    )
    .all(from, source, dayFrom(from));
  const shapes = listSourceShapes(db, source);
  const [newest, previous] = shapes;
  const registered = buildSourceRegistry(db, config).some((definition) => definition.id === source);
  return {
    source,
    registered,
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
