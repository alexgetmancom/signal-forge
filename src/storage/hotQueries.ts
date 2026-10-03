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
export type HotQuery = {
  name: string;
  sql: string;
  params: readonly (string | number)[];
  /**
   * Why this read is allowed to scan, for the few that are.
   *
   * Most of these exist because an index serves them, and a scan means the index went away. One
   * does not: the timings totals group every instrumented name over a window, so the rows it reads
   * are the rows it answers from and there is nothing for an index to narrow. It is here to be
   * timed rather than to be indexed, and a reason written down is the difference between that and
   * a read nobody noticed was scanning.
   */
  scansByDesign?: string;
};

/**
 * The reads over what a source said, and what we derived from it.
 *
 * Split from the other two groups only because one declaration of all of them is over the length a
 * new declaration gets. The division is which part of the service a read is about -- what came in,
 * what went out, and the machinery between them -- and a new entry goes in whichever of the three
 * it describes; `HOT_QUERIES` below is still the list.
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
    // The read that proved a plan is not a cost. This is `timings`' own totals, correlated subquery
    // and all, and it is here as the whole statement rather than as a representative fragment
    // because the fragment is what was here before and it is the fragment that was fast. Written
    // once with the day leading the key it answered in 6,979 ms instead of 191, with every step of
    // the plan still a SEARCH -- the subquery had lost its per-name seek and re-sought the range
    // for each of the eighty-odd names. Only the clock says that.
    name: "the timings totals, with each name's newest failure",
    sql: `SELECT m.name, SUM(m.calls) AS calls,
                 (SELECT f.last_error_type FROM code_metrics f
                   WHERE f.name=m.name AND f.bucket_start>=?1 AND f.bucket_start<=?2
                     AND f.last_error_at IS NOT NULL
                   ORDER BY f.last_error_at DESC, f.bucket_start LIMIT 1) AS lastErrorType
          FROM code_metrics m WHERE m.bucket_start>=?1 AND m.bucket_start<=?2 GROUP BY m.name`,
    params: ["2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"],
    scansByDesign:
      "it groups every instrumented name over the window, so the rows read are the rows answered " +
      "from. On production, where ANALYZE has run, the planner turns it into a skip-scan of the " +
      "key; on an empty database it is a plain scan of the range. Either way the cost is the " +
      "window, which is what METRIC_DAYS caps.",
  },
  {
    // The seek the incremental fold does on every collection. It was missing until `index-cost`
    // reported `source_collection_metrics_source_time` at 14.1 MB with no hot read, and the reason
    // it was missing is that the read is inside an `INSERT ... SELECT`. This entry was the patch:
    // the SELECT, lifted out and standing in for the statement that contains it. `HOT_WRITES`
    // below is the statement itself, and this stays because the reads of one attempt by key are
    // also what `peak_rss_mb` is updated through.
    name: "one attempt by source and time",
    sql: "SELECT records_processed, peak_rss_mb FROM source_collection_metrics WHERE source = ? AND collected_at = ?",
    params: ["arena", "2026-01-01T00:00:00.000Z"],
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

/**
 * The reads that keep this service's own machinery moving: its queues, its ledgers, its journal.
 *
 * A third group rather than a longer second one, for the length rule, and the division turned out
 * to be a real one. Every entry here was added in a single pass, and they share a shape: a queue
 * polled by due time, or a ledger asked about a window. Nobody thought of those as hot reads, which
 * is why `check-indexes` found sixteen declared indexes whose only evidence of use was a sentence
 * somebody wrote in a record. Thirteen of them are read by the statements below; three were read by
 * nothing and migration 077 drops them.
 */
const MACHINERY_QUERIES: readonly HotQuery[] = [
  {
    // The alerts a stopped process left mid-send, read on every boot before anything else is sent:
    // an attempt still marked `sending` was either delivered or not, and nothing in the database
    // can say which. `status` leads the index, so the literal is enough to seek on.
    name: "alerts left mid-send by a stopped process",
    sql: "SELECT state_version,to_state_json FROM alert_attempts WHERE status='sending' ORDER BY state_version",
    params: [],
  },
  {
    // The delivery queue, polled every cycle. The pair is one index because neither half narrows
    // alone: almost every row ends up `sent`, and almost every `next_attempt_at` is in the past.
    name: "destinations with something pending",
    sql: "SELECT destination_id FROM deliveries WHERE status='pending' AND next_attempt_at<=? GROUP BY destination_id ORDER BY MIN(id)",
    params: ["2026-01-01T00:00:00.000Z"],
  },
  {
    name: "reminders that have come due, with their deadline",
    sql: `SELECT lr.deadline_id,lr.offset_days,ld.deadline_at FROM lifecycle_reminders lr
          JOIN lifecycle_deadlines ld ON ld.id=lr.deadline_id
          WHERE ld.active=1 AND lr.batch_id IS NULL AND lr.due_at<=? AND ld.deadline_at>?
          ORDER BY lr.due_at,lr.deadline_id,lr.offset_days`,
    params: ["2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
  },
  {
    name: "deadlines inside a window",
    sql: "SELECT id,stable_key,deadline_at FROM lifecycle_deadlines WHERE active=1 AND deadline_at>=? AND deadline_at<=? ORDER BY deadline_at,id",
    params: ["2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"],
  },
  {
    // Whether anything has been judged at all since an instant, which decides whether the standing
    // of an event can be trusted. One row either way, and the index covers it.
    name: "whether anything was judged since an instant",
    sql: "SELECT 1 one FROM event_evaluations WHERE evaluated_at>=? LIMIT 1",
    params: ["2026-01-01T00:00:00.000Z"],
  },
  {
    name: "one operation's recent attempts on one source",
    sql: `SELECT outcome,attempted_at,cost_usd,error_type FROM deepseek_usage
          WHERE event_id IS NULL AND operation=? AND source=? ORDER BY attempted_at DESC, id DESC LIMIT ?`,
    params: ["summarize", "arena", 8],
  },
  {
    name: "what was spent over a window",
    sql: "SELECT COALESCE(SUM(attempts),0) AS attempts FROM deepseek_usage WHERE attempted_at>=? AND attempted_at<?",
    params: ["2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"],
  },
  {
    // The release report's count of failed operations since a boot. Written this way on purpose:
    // the journal's own newest-first read orders by `id` and the planner scans for it, so the
    // statement that names this index is the one bounded by time. See migration 077's note.
    name: "operations that failed since an instant",
    sql: "SELECT COUNT(*) n FROM operator_journal WHERE outcome='failed' AND recorded_at>=?",
    params: ["2026-01-01T00:00:00.000Z"],
  },
  {
    name: "what was suppressed recently, by reason",
    sql: "SELECT reason,COUNT(*) c FROM suppressions WHERE recorded_at > ? GROUP BY reason ORDER BY c DESC",
    params: ["2026-01-01T00:00:00.000Z"],
  },
  {
    name: "the newest publications",
    sql: "SELECT ref,post_id,published_at FROM publications ORDER BY published_at DESC,post_id DESC LIMIT ?",
    params: [20],
  },
  {
    name: "stories touched since an instant, newest first",
    sql: `SELECT id,stable_key,updated_at FROM stories
          WHERE confidence IN ('observed','supported') AND (? IS NULL OR updated_at>=?)
          ORDER BY updated_at DESC LIMIT ?`,
    params: ["2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", 50],
  },
  {
    name: "hypotheses that have gone quiet",
    sql: "SELECT story_id FROM hypotheses WHERE resolved_at IS NULL AND status <> 'stale' AND updated_at <= ?",
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

export const HOT_QUERIES: readonly HotQuery[] = [...INTAKE_QUERIES, ...MACHINERY_QUERIES, ...PUBLISHED_QUERIES];

/**
 * A write whose plan and cost are worth checking, which `HOT_QUERIES` could not hold.
 *
 * The list above is reads, and that was a blind spot with a size. `source_collection_metrics_source_time`
 * was the largest index in the database at 14.1 MB, and `index-cost` reported that no hot read
 * named it -- correctly, because its only caller is the `INSERT ... SELECT` the incremental
 * collection fold runs after every attempt. An index can be load-bearing for a statement that
 * returns no rows, and from the outside that is indistinguishable from an index nothing uses.
 *
 * Patching it by lifting the SELECT out and calling it a read is what was done first. It is a
 * worse answer than it looks: the lifted fragment is not the statement, and migration 075's lesson
 * was precisely that a fragment can be fast while the statement containing it is thirty-four times
 * slower. So the statements are here whole.
 *
 * They are planned like a read and timed inside a transaction that is rolled back, which is why
 * `params` may carry values that would be nonsense to commit: nothing here is ever kept.
 */
export type HotWrite = {
  name: string;
  sql: string;
  params: readonly (string | number | null)[];
  /** What this write seeks through, named, so a migration that takes it away has something to fail against. */
  seeks: string;
};

export const HOT_WRITES: readonly HotWrite[] = [
  {
    // The statement the patched read above stood in for. Run once per collection, per source.
    name: "fold one attempt into its day",
    sql: `INSERT INTO source_collection_days(
            source, day, outcome, attempts, records_processed, events_created, new_events,
            changed_events, removed_events, peak_rss_max, peak_rss_total, peak_rss_samples,
            first_at, last_at
          )
          SELECT source, substr(collected_at, 1, 10),
                 CASE WHEN success = 1 THEN 'success' ELSE 'unknown' END,
                 1, records_processed, events_created, new_events, changed_events, removed_events,
                 peak_rss_mb, peak_rss_mb, (peak_rss_mb IS NOT NULL), collected_at, collected_at
          FROM source_collection_metrics WHERE source = ? AND collected_at = ?
          ON CONFLICT(day, source, outcome) DO UPDATE SET attempts = attempts + 1`,
    params: ["arena", "2026-01-01T00:00:00.000Z"],
    seeks: "source_collection_metrics by (source, collected_at), and source_collection_days by its own key",
  },
  {
    // Written after the collection returns, once the peak is known, against the row recordOutcome
    // just inserted. Same seek, different statement: a key that serves the INSERT's SELECT and not
    // this would leave a scan of the whole table on every successful collection.
    name: "stamp a peak onto one attempt",
    sql: "UPDATE source_collection_metrics SET peak_rss_mb = ? WHERE source = ? AND collected_at = ?",
    params: [1, "arena", "2026-01-01T00:00:00.000Z"],
    seeks: "source_collection_metrics by (source, collected_at)",
  },
  {
    // Every instrumented call in the service goes through this, which makes it the most frequent
    // write there is. Migration 075 made the key the table for this seek; it is here so that
    // changing the key again is measured on the write as well as on the report.
    name: "record one call against its bucket",
    sql: `INSERT INTO code_metrics(
            name,bucket_start,calls,failures,total_duration_ms,min_duration_ms,max_duration_ms,
            duration_buckets_json,peak_growth_kb,max_peak_growth_kb,last_called_at
          ) VALUES(?,?,1,0,1,1,1,'[]',0,0,?)
          ON CONFLICT(name,bucket_start) DO UPDATE SET calls = calls + 1`,
    params: ["rehearsal.write", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    seeks: "code_metrics by its own primary key, which since 075 is the table",
  },
  {
    // Run on every failed collection, and the only write that reads `records` by source alone.
    name: "break confirmation of a disappearance",
    sql: "UPDATE records SET missing_count = 0 WHERE source = ?",
    params: ["arena"],
    seeks: "records by the leading column of its primary key",
  },
  {
    // The tail of every successful collection: drop the snapshots nothing points at, keeping the
    // last two. Two NOT IN subqueries over `events` and over `snapshots` itself, which is the
    // shape that gets expensive quietly as the archive grows.
    name: "drop the snapshots nothing points at",
    sql: `DELETE FROM snapshots WHERE source = ?
            AND id NOT IN (SELECT snapshot_id FROM events)
            AND id NOT IN (SELECT id FROM snapshots WHERE source = ? ORDER BY id DESC LIMIT 2)`,
    params: ["arena", "arena"],
    seeks: "snapshots by source, and events by snapshot_id",
  },
  {
    // Rebuilding one model: its fields and conflicts go, then the model itself. The only statements
    // that name `model_facts_key`, and all three are deletes -- which is why a list of reads had
    // nothing to say about that index either.
    name: "drop one model's fields before rebuilding it",
    sql: "DELETE FROM model_fact_fields WHERE canonical_id IN (SELECT canonical_id FROM model_facts WHERE canonical_key=?)",
    params: ["vendor:thing"],
    seeks: "model_facts by canonical_key, and model_fact_fields by its own key",
  },
  {
    // Retention's largest delete, chunked. It names the key it deletes by, which is the one thing
    // a migration changing that key has to carry with it: this statement deleted by `rowid` until
    // 076 took the rowid away.
    name: "expire a chunk of raw collection attempts",
    sql: `DELETE FROM source_collection_metrics
          WHERE (source, collected_at) IN (
            SELECT source, collected_at FROM source_collection_metrics
            WHERE collected_at < ? AND substr(collected_at, 1, 10) IN (SELECT day FROM source_collection_days)
            LIMIT ?
          )`,
    params: ["2020-01-01T00:00:00.000Z", 1],
    seeks: "source_collection_metrics by (source, collected_at), and source_collection_days by day",
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
