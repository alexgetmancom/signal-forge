import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { Collection, RecordData } from "./events/types.js";
import type { Fetch } from "./http-client.js";
import { fetchText } from "./sources/http.js";

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

type Verdict = { total: number; model: string; published: string };

function declaredTotal(record: RecordData): Verdict | null {
  const total = record.parameters;
  if (typeof total !== "number" || !Number.isFinite(total) || total < NOVEL_PARAMETER_FLOOR) return null;
  // A model that names what it was built from has already told us it is not the first of its kind.
  if (record.derivative === true) return null;
  const published = typeof record.created === "string" ? record.created : null;
  return { total: Math.trunc(total), model: String(record.id), published: published ?? "" };
}

/**
 * Records every parameter count the collection declares and marks the records that published one
 * first. Runs inside the caller's transaction, with the snapshot and events it belongs to.
 */
export function markNovelWeights(db: Database, collection: Collection, now: string): Collection {
  const declared = collection.records.map((record) => declaredTotal(record));
  if (declared.every((verdict) => verdict === null)) return collection;
  const first = db.query<{ first_model: string }, [number]>("SELECT first_model FROM weight_totals WHERE total=?");
  const claim = db.prepare(CLAIM);
  const records = collection.records.map((record, index) => {
    const verdict = declared[index];
    if (!verdict) return record;
    claim.run(verdict.total, verdict.model, isoOrNull(verdict.published) ?? now);
    if (first.get(verdict.total)?.first_model !== verdict.model) return record;
    const reasons = [...(Array.isArray(record.notableReasons) ? record.notableReasons : []), "novel-parameter-total"];
    return { ...record, discoveryStatus: "notable", notableReasons: reasons };
  });
  return { ...collection, records };
}

/**
 * A count belongs to the earliest publication of it. Written as an upsert rather than a plain
 * insert so that seeding the ledger from the established catalogue takes a count back from a copy
 * that claimed it first only because it was the first one this deployment happened to read.
 */
const CLAIM = `INSERT INTO weight_totals(total,first_model,first_published) VALUES(?,?,?)
  ON CONFLICT(total) DO UPDATE SET first_model=excluded.first_model, first_published=excluded.first_published
  WHERE excluded.first_published < weight_totals.first_published`;

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

const catalogueModel = z.object({
  id: z.string().min(1),
  createdAt: z.string().min(1),
  safetensors: z.object({ total: z.number().nonnegative().nullish() }).nullish(),
  cardData: z.object({ base_model: z.unknown().nullish() }).nullish(),
  private: z.boolean().default(false),
});
const catalogueSchema = z.array(catalogueModel).min(1);

/**
 * The catalogue of models the world already runs, read once so their parameter counts are held by
 * the laboratories that published them.
 *
 * Without it the ledger is only as old as this deployment, and a count first published in March is
 * claimed by whoever re-uploaded it yesterday: a sweep on 2026-09-14 marked eight such copies from
 * a single account as new weights. Ordered by downloads and by likes, which is where a model that
 * matters ends up whatever it was called on release day.
 */
export async function seedWeightTotals(db: Database, request: Fetch = fetch): Promise<Record<string, number>> {
  const claim = db.prepare(CLAIM);
  const seen = new Set<string>();
  let considered = 0;
  const before = Number(db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM weight_totals").get()?.c ?? 0);
  for (const sort of ["downloads", "likes"]) {
    const url =
      `https://huggingface.co/api/models?sort=${sort}&direction=-1&limit=1000` +
      "&expand[]=createdAt&expand[]=safetensors&expand[]=cardData&expand[]=private";
    const models = catalogueSchema.parse(JSON.parse(await fetchText(url, { accept: "application/json" }, request)));
    // Oldest first: the upsert only moves a count backwards in time, and reading in this order means
    // one pass settles it rather than depending on where a model sat in the ranking.
    const ordered = [...models].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const model of ordered) {
      if (model.private || seen.has(model.id)) continue;
      seen.add(model.id);
      const total = model.safetensors?.total;
      const base = model.cardData?.base_model;
      const derivative = Array.isArray(base) ? base.length > 0 : Boolean(base);
      const published = isoOrNull(model.createdAt);
      if (typeof total !== "number" || total < NOVEL_PARAMETER_FLOOR || derivative || !published) continue;
      considered += 1;
      claim.run(Math.trunc(total), model.id, published);
    }
  }
  const after = Number(db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM weight_totals").get()?.c ?? 0);
  return { read: seen.size, eligible: considered, claimed: after - before, totals: after };
}
