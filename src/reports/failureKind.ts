/**
 * What kind a failed collection was, as a SQL expression over `source_collection_metrics`.
 *
 * Rows written before migration 052 carry no kind. The guard's own refusals are still recognisable
 * in them by the sentence `collectionDegraded` writes, and reading that here rather than in the
 * poller keeps the recognition where a wrong guess costs a mislabelled report instead of a leaked
 * response body. The three reports that count failures by kind read it from here, so there is one
 * place to retire it: when `SELECT COUNT(*) FROM source_collection_metrics WHERE success = 0 AND
 * failure_kind IS NULL` is zero, which the table's 90 days of retention will make true by itself.
 */
export const FAILURE_KIND = `COALESCE(failure_kind, CASE WHEN error LIKE 'Collection degraded:%' THEN 'degraded' ELSE 'before_kinds_were_recorded' END)`;
