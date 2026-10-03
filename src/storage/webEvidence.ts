import type { Database } from "bun:sqlite";
import { narrowWebEvidence } from "../events/web.js";
import { writeTransaction } from "./transaction.js";

/** Rows per transaction. Each one can carry a megabyte of JSON, so the journal stays bounded. */
const CHUNK = 50;

export type NarrowingResult = { examined: number; narrowed: number; freedBytes: number; elapsedMs: number };

/**
 * Narrows the web change events that were stored before `narrowWebEvidence` existed.
 *
 * The write path narrows every new one, so this is a one-time repair that nothing calls on a
 * schedule. It is a command rather than a migration because which strings changed is decided by
 * the same `normalizeWebString` the readers use, and a migration is SQL.
 *
 * Only rows above `minBytes` are considered and narrowing puts a row far below it, so running this
 * twice does nothing the second time. It is safe to interrupt: each chunk is its own transaction,
 * and a row it has already reached is already correct.
 */
export function narrowStoredWebEvidence(
  db: Database,
  input: { minBytes: number; limit: number },
  now = () => performance.now(),
): NarrowingResult {
  const started = now();
  const candidates = db
    .query<{ id: number; before_json: string; after_json: string }, [number, number]>(
      `SELECT id, before_json, after_json FROM events
       WHERE stream='web' AND kind='changed' AND before_json IS NOT NULL AND after_json IS NOT NULL
         AND LENGTH(before_json) + LENGTH(after_json) > ?
       ORDER BY LENGTH(before_json) + LENGTH(after_json) DESC LIMIT ?`,
    )
    .all(input.minBytes, input.limit);
  let narrowed = 0;
  let freedBytes = 0;
  for (let start = 0; start < candidates.length; start += CHUNK) {
    const chunk = candidates.slice(start, start + CHUNK);
    freedBytes += writeTransaction(db, () => {
      const update = db.query<never, [string, string, number]>(
        "UPDATE events SET before_json=?, after_json=? WHERE id=?",
      );
      let freed = 0;
      for (const row of chunk) {
        const [before, after] = narrowWebEvidence(row.before_json, row.after_json);
        if (before === null || after === null) continue;
        const was = row.before_json.length + row.after_json.length;
        const became = before.length + after.length;
        // A row the narrowing did not shrink is left as it is, so nothing is rewritten for nothing.
        if (became >= was) continue;
        update.run(before, after, row.id);
        freed += was - became;
        narrowed++;
      }
      return freed;
    });
  }
  return { examined: candidates.length, narrowed, freedBytes, elapsedMs: Math.round(now() - started) };
}
