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

/**
 * The reads over what a source said, and what we derived from it.
 *
 * Split from the published half only because one declaration of all of them is over the length a
 * new declaration gets. The division is which side of the service a read is about, and a new entry
 * goes in whichever of the two it describes; `HOT_QUERIES` below is still the list.
 */
const INTAKE_QUERIES: readonly HotQuery[] = [
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
    name: "records of one stream",
    sql: "SELECT source, id FROM records WHERE stream = ?",
    params: ["arena"],
  },
  {
    name: "collection days in a window",
    sql: "SELECT source, SUM(attempts) FROM source_collection_days WHERE day >= ? GROUP BY source",
    params: ["2026-01-01"],
  },
  {
    name: "one metric name's buckets in a window",
    sql: "SELECT last_error_type FROM code_metrics WHERE name = ? AND bucket_start >= ? AND last_error_at IS NOT NULL",
    params: ["poll.cycle", "2026-01-01T00:00:00.000Z"],
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
    name: "shapes of one source",
    sql: "SELECT hash,shape_json FROM source_shapes WHERE source = ? ORDER BY last_seen_at DESC LIMIT 8",
    params: ["arena"],
  },
  {
    name: "unexpired snapshot bodies",
    sql: "SELECT id FROM snapshots WHERE body IS NOT NULL AND collected_at < ?",
    params: ["2026-01-01T00:00:00.000Z"],
  },
];

/** The reads over what this service decided, sent, and recorded itself doing. */
const PUBLISHED_QUERIES: readonly HotQuery[] = [
  {
    name: "batches due to speak",
    sql: "SELECT id FROM batches WHERE sealed = 0 AND ready_at <= ? ORDER BY ready_at, id",
    params: ["2026-01-01T00:00:00.000Z"],
  },
  {
    name: "claims of one story",
    sql: "SELECT claim, confidence, supported_by FROM story_claims WHERE story_id = ?",
    params: [1],
  },
  {
    name: "the boot before this one, by render fingerprint",
    sql: "SELECT hash FROM release_renders WHERE booted_at<? AND corpus=? ORDER BY booted_at DESC",
    params: ["2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z|1"],
  },
  {
    name: "the cards of one render",
    sql: "SELECT event_id,hash FROM release_render_cards WHERE boot_id=?",
    params: ["boot"],
  },
  {
    // Read once per batch that carries a codename, and the reason it has a window at all: without
    // one it grew with every newsroom post the archive will ever hold.
    name: "announcements in the window a card looks back over",
    sql: "SELECT id FROM events WHERE detected_at>=? AND stream IN ('news','pages','changelog') AND kind='new'",
    params: ["2026-01-01T00:00:00.000Z"],
  },
  {
    name: "operator journal, mutations only",
    sql: "SELECT id FROM operator_journal WHERE mutates = 1 ORDER BY id DESC LIMIT 50",
    params: [],
  },
];

export const HOT_QUERIES: readonly HotQuery[] = [...INTAKE_QUERIES, ...PUBLISHED_QUERIES];

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
