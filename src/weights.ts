import type { Database } from "bun:sqlite";
import type { Collection, RecordData } from "./events/types.js";

/**
 * Whether a set of weights is the first of its kind or a copy of somebody else's.
 *
 * A discovery sweep sees a repository the hour its weights land, before anybody has reacted to it,
 * and at that moment popularity says nothing: of 13,770 repositories captured in four days, 12,850
 * had no likes at all and the busiest had six. The parameter count does say something, because it
 * is a property of the weights rather than of the page: a model nobody has published before carries
 * a count nobody has published before, and a copy reproduces its original's exactly.
 *
 * The ledger lives here rather than in the collector because it is memory, and a collector is a
 * function of one HTTP response. Its verdict is stable by construction: the first publisher of a
 * count keeps the verdict on every later reading, so a body that says "novel" today does not
 * quietly stop saying it tomorrow and report a change that never happened.
 */
const NOVEL_PARAMETER_FLOOR = 20_000_000_000;

type Verdict = { total: number; model: string };

function declaredTotal(record: RecordData): Verdict | null {
  const total = record.parameters;
  if (typeof total !== "number" || !Number.isFinite(total) || total < NOVEL_PARAMETER_FLOOR) return null;
  // A model that names what it was built from has already told us it is not the first of its kind.
  if (record.derivative === true) return null;
  return { total: Math.trunc(total), model: String(record.id) };
}

/**
 * Records every parameter count the collection declares and marks the records that published one
 * first. Runs inside the caller's transaction, with the snapshot and events it belongs to.
 */
export function markNovelWeights(db: Database, collection: Collection, now: string): Collection {
  const declared = collection.records.map((record) => declaredTotal(record));
  if (declared.every((verdict) => verdict === null)) return collection;
  const first = db.query<{ first_model: string }, [number]>("SELECT first_model FROM weight_totals WHERE total=?");
  const claim = db.query<never, [number, string, string]>(
    "INSERT INTO weight_totals(total,first_model,first_seen) VALUES(?,?,?) ON CONFLICT(total) DO NOTHING",
  );
  const records = collection.records.map((record, index) => {
    const verdict = declared[index];
    if (!verdict) return record;
    claim.run(verdict.total, verdict.model, now);
    if (first.get(verdict.total)?.first_model !== verdict.model) return record;
    const reasons = [...(Array.isArray(record.notableReasons) ? record.notableReasons : []), "novel-parameter-total"];
    return { ...record, discoveryStatus: "notable", notableReasons: reasons };
  });
  return { ...collection, records };
}
