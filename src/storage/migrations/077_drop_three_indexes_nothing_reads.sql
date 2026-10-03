-- Three indexes that nothing reads, found by the check that now asks.
--
-- `check-indexes` shipped with sixteen indexes in a closed RECORD: declared by a migration, named
-- by no hot statement, and explained only by a sentence somebody wrote. Going through that list
-- statement by statement, thirteen turned out to have a real reader, and those statements are now
-- in `src/storage/hotQueries.ts` where their plans are checked. Three had none:
--
--   snapshots_collected    188 KB   `snapshots(collected_at)`. Redundant: `snapshots_unexpired` is
--                                   the same column `WHERE body IS NOT NULL`, and that is the one
--                                   the planner picks for both body sweeps. Nothing reads snapshots
--                                   by time including the expired ones -- `pruneSnapshots` filters
--                                   `collected_at` inside a window function that has to read every
--                                   row anyway, so it scans either way.
--   model_facts_updated    220 KB   `model_facts(updated_at)`. The one read that could have used it
--                                   is `ORDER BY updated_at DESC, canonical_id LIMIT ?`, and the
--                                   second sort key means the planner scans and sorts instead --
--                                   verified against production, where ANALYZE has run, not only
--                                   against an empty schema.
--   stories_released        72 KB   `stories(released_at)`. The column is written and selected and
--                                   never filtered or ordered by, anywhere.
--
-- 480 KB, which is not the point. Each of these was paid for on every insert and every update of
-- its table -- snapshots are written on every collection -- for an index that is never read, and
-- the reason all three survived is that an unused index and a load-bearing one look identical from
-- outside. Three of sixteen is also the honest hit rate for that kind of list, which is worth
-- knowing before the next one is written.
--
-- Nothing about what is stored changes. If a read of one of these columns is added later, the index
-- comes back in the migration that adds it, together with the statement -- which is the rule.
DROP INDEX snapshots_collected;
DROP INDEX model_facts_updated;
DROP INDEX stories_released;

ANALYZE;
