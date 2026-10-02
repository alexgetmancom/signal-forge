import type { Database } from "bun:sqlite";

/**
 * A transaction that holds the write lock from its first statement rather than from its first write.
 *
 * Every transaction in this service writes, and most of them look before they do: a collection reads
 * the newest event id, a reminder pass reads the deadlines due. A deferred `BEGIN` takes its read
 * snapshot with that first read, and when it then asks to write there are two ways it is refused
 * without waiting at all -- another connection committed in the meantime and the snapshot is stale
 * (`SQLITE_BUSY_SNAPSHOT`), or another connection holds the lock right now (`SQLITE_BUSY`). SQLite
 * does not call the busy handler for either, because waiting could not help a snapshot that already
 * lost, so the five seconds of `busy_timeout` were never spent. A source whose collection was fine
 * went red instead: twenty-seven times in a week on production, sixteen of the one kind and eleven of
 * the other, until nothing but the starting statement differed.
 *
 * `BEGIN IMMEDIATE` asks for the lock first, and a lock that is asked for before anything is read can
 * be waited for. The cost is that a transaction which would have written nothing still queues behind
 * the other writer; none here is read-only, and `scripts/check-sql.ts` keeps it that way by refusing
 * a bare `db.transaction` in `src/`.
 *
 * Nested, it is a savepoint of the transaction around it, which is what it was before.
 */
export function writeTransaction<T>(db: Database, work: () => T): T {
  return db.transaction(work).immediate();
}
