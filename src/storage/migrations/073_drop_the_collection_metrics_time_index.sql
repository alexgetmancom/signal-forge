-- Every reader of this table carries a source, so each one seeks the composite index instead; the
-- plans were measured on a copy of production before this was written. ANALYZE because the planner
-- has to be told the index is gone before it will stop costing plans against it.
DROP INDEX source_collection_metrics_collected;
ANALYZE;
