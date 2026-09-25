/**
 * The reads whose plan is worth checking, each named beside the index it exists for.
 *
 * An index that the planner ignores and an index that was never created look identical from the
 * outside: both leave the query scanning, and nothing in the gate, the tests or `verify` can tell
 * them apart. Migration 049 shipped five indexes and the planner used none of them until `ANALYZE`
 * populated `sqlite_stat1`, which was found by hand and could as easily not have been.
 *
 * So the plan is checked by a machine. `rehearse-migration` runs `EXPLAIN QUERY PLAN` for each of
 * these against a copy of production before and after the migration, and a read that was a SEARCH
 * and became a SCAN fails the rehearsal. Adding an index without adding the query it was for leaves
 * the same blind spot the indexes had, so the two belong in one commit.
 *
 * The parameters are placeholders: a plan depends on the shape of a query, never on its literals.
 */
export type HotQuery = { name: string; sql: string; params: readonly (string | number)[] };

export const HOT_QUERIES: readonly HotQuery[] = [
  {
    name: "events by recency",
    sql: "SELECT id FROM events WHERE detected_at >= ? ORDER BY detected_at DESC LIMIT 50",
    params: ["2026-01-01T00:00:00.000Z"],
  },
  {
    name: "events of one record",
    sql: "SELECT id FROM events WHERE source = ? AND entity_id = ? ORDER BY id",
    params: ["arena", "x"],
  },
  {
    name: "batches due to speak",
    sql: "SELECT id FROM batches WHERE sealed = 0 AND ready_at <= ? ORDER BY ready_at, id",
    params: ["2026-01-01T00:00:00.000Z"],
  },
  {
    name: "records of one stream",
    sql: "SELECT source, id FROM records WHERE stream = ?",
    params: ["arena"],
  },
  {
    name: "collection metrics in a window",
    sql: "SELECT source, COUNT(*) FROM source_collection_metrics WHERE collected_at >= ? GROUP BY source",
    params: ["2026-01-01T00:00:00.000Z"],
  },
  {
    name: "failures of one source",
    sql: "SELECT collected_at FROM source_collection_metrics WHERE source = ? AND collected_at >= ? AND success = 0",
    params: ["arena", "2026-01-01T00:00:00.000Z"],
  },
  {
    name: "model fact members of one model",
    sql: "SELECT kind, ref FROM model_fact_members WHERE canonical_key = ?",
    params: ["x"],
  },
  {
    name: "failure evidence of one source",
    sql: "SELECT observed_at FROM source_failure_evidence WHERE source = ? ORDER BY observed_at DESC LIMIT 20",
    params: ["arena"],
  },
  {
    name: "unexpired snapshot bodies",
    sql: "SELECT id FROM snapshots WHERE body IS NOT NULL AND collected_at < ?",
    params: ["2026-01-01T00:00:00.000Z"],
  },
  {
    name: "operator journal, mutations only",
    sql: "SELECT id FROM operator_journal WHERE mutates = 1 ORDER BY id DESC LIMIT 50",
    params: [],
  },
];

/**
 * Whether any step of a plan reads a whole table.
 *
 * Per step, not per plan: a join whose first table is searched and whose second is scanned still
 * reads a whole table, and a check over the joined string would call that indexed. Scanning an
 * index rather than the table -- `SCAN x USING COVERING INDEX i` -- is not what this is about.
 */
export function scansATable(plan: string): boolean {
  return plan.split("|").some((step) => /\bSCAN\b/.test(step) && !/\bUSING (?:COVERING )?INDEX\b/.test(step));
}
