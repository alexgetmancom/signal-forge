/**
 * Every read of the model_facts tables: the shape a caller gets back, and the queries that build it.
 * The projector and its writes stay in modelFacts.ts, and nothing here writes.
 */

import type { Database } from "bun:sqlite";
import { normalizeIdentity } from "./events/identity.js";
import type { Confidence, EvidenceType } from "./events/types.js";
import type { ModelFactConflict } from "./modelFacts.js";

type ModelFact<T = unknown> = {
  value: T;
  confidence: Confidence;
  evidenceType: EvidenceType;
  source: string;
  eventId: number | null;
  observedAt: string;
};

export type ModelFactsView = {
  canonicalId: string;
  firstSeenAt: string;
  updatedAt: string;
  facts: Record<string, ModelFact>;
  conflicts: ModelFactConflict[];
};

export type ModelFactsQuery = { limit?: number | undefined };

function view(db: Database, row: { canonical_id: string; first_seen_at: string; updated_at: string }): ModelFactsView {
  const fields = db
    .query<
      {
        field: string;
        value_json: string;
        confidence: Confidence;
        evidence_type: EvidenceType;
        source: string;
        event_id: number | null;
        observed_at: string;
      },
      [string]
    >(
      "SELECT field,value_json,confidence,evidence_type,source,event_id,observed_at FROM model_fact_fields WHERE canonical_id=? ORDER BY field",
    )
    .all(row.canonical_id);
  const facts: Record<string, ModelFact> = {};
  for (const field of fields) {
    facts[field.field] = {
      value: JSON.parse(field.value_json) as unknown,
      confidence: field.confidence,
      evidenceType: field.evidence_type,
      source: field.source,
      eventId: field.event_id,
      observedAt: field.observed_at,
    };
  }
  const conflicts = db
    .query<
      ModelFactConflict & {
        field: string;
        incumbent_event_id: number;
        challenger_event_id: number;
        detected_at: string;
      },
      [string]
    >(
      "SELECT field,incumbent_event_id,challenger_event_id,detected_at FROM model_fact_conflicts WHERE canonical_id=? ORDER BY detected_at,incumbent_event_id,challenger_event_id",
    )
    .all(row.canonical_id)
    .map((conflict) => ({
      field: conflict.field,
      incumbentEventId: conflict.incumbent_event_id,
      challengerEventId: conflict.challenger_event_id,
      detectedAt: conflict.detected_at,
    }));
  return { canonicalId: row.canonical_id, firstSeenAt: row.first_seen_at, updatedAt: row.updated_at, facts, conflicts };
}

export function listModelFacts(db: Database, query: ModelFactsQuery = {}): ModelFactsView[] {
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Model limit must be between 1 and 100");
  return db
    .query<{ canonical_id: string; first_seen_at: string; updated_at: string }, [number]>(
      "SELECT canonical_id,first_seen_at,updated_at FROM model_facts ORDER BY updated_at DESC,canonical_id LIMIT ?",
    )
    .all(limit)
    .map((row) => view(db, row));
}

export function getModelFacts(db: Database, canonicalId: string): ModelFactsView | null {
  const exact = db
    .query<{ canonical_id: string; first_seen_at: string; updated_at: string }, [string]>(
      "SELECT canonical_id,first_seen_at,updated_at FROM model_facts WHERE canonical_id=?",
    )
    .get(canonicalId);
  if (exact) return view(db, exact);
  const normalized = normalizeIdentity(canonicalId);
  const fallback = db
    .query<{ canonical_id: string; first_seen_at: string; updated_at: string }, []>(
      "SELECT canonical_id,first_seen_at,updated_at FROM model_facts ORDER BY canonical_id",
    )
    .all()
    .find((row) => normalizeIdentity(row.canonical_id) === normalized);
  return fallback ? view(db, fallback) : null;
}
