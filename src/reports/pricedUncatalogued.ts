import type { Database } from "bun:sqlite";

/**
 * A model OpenAI charges for that neither of its own catalogues lists.
 *
 * The price page, the model index and the API catalogue are three independent readings of the same
 * roster, and a model present in the first and absent from the other two is either a page published
 * early or a catalogue that forgot something. On 2026-10-02 this named `gpt-5.5-cyber` and
 * `gpt-rosalind-research`, both priced and both answering 404 at their documentation address.
 *
 * It could not be asked before that day. The price table was read by its first column and a regex
 * that required a digit after `gpt-`, so 39 of the 82 priced models were invisible and these two
 * had no price row at all -- the cross-check had nothing to cross.
 *
 * A dated snapshot is not a gap. `gpt-4-0613` and `gpt-4-turbo-2024-04-09` are priced because
 * fine-tuning still accepts them, and the catalogues list the base model rather than every dated
 * build of it; both were the whole of the noise in the first reading. So a model whose name ends in
 * a date or a four-digit build is set aside when the name without it is catalogued -- and kept when
 * it is not, because then the base is missing too and that is the same finding.
 *
 * `observedAt` is when the price first appeared, from `records.first_seen_at`. It used to be
 * `observed_at`, which every collection overwrites, so a gap that had stood for weeks was reported
 * as minutes old and the one thing a reader wants to know about it -- how long it has been priced
 * and undocumented -- was the one thing the report could not say.
 */
export type PricedUncatalogued = { model: string; tiers: string[]; url: string; observedAt: string };

/** `-0613`, `-2024-04-09`: a build of a model, not a model. */
const SNAPSHOT = /-(?:\d{4}-\d{2}-\d{2}|\d{4})$/;

type PricedRow = { model: string; tier: string; url: string; observed_at: string };

export function pricedUncatalogued(db: Database): {
  priced: number;
  catalogued: number;
  snapshots: string[];
  gaps: PricedUncatalogued[];
} {
  // The catalogues key a record by the model id, so the id column answers without reading a body.
  const catalogued = new Set(
    db
      .query<{ id: string }, []>("SELECT DISTINCT id FROM records WHERE source IN ('openai-model-index','openai')")
      .all()
      .map((row) => row.id),
  );
  const priced = db
    .query<PricedRow, []>(
      `SELECT json_extract(body,'$.model') AS model, json_extract(body,'$.tier') AS tier,
              json_extract(body,'$.url') AS url, min(COALESCE(first_seen_at,observed_at)) AS observed_at
       FROM records WHERE source='openai-pricing' GROUP BY model, tier ORDER BY model, tier`,
    )
    .all();
  const byModel = new Map<string, PricedRow[]>();
  for (const row of priced) byModel.set(row.model, [...(byModel.get(row.model) ?? []), row]);
  const snapshots: string[] = [];
  const gaps: PricedUncatalogued[] = [];
  for (const [model, rows] of byModel) {
    if (catalogued.has(model)) continue;
    if (SNAPSHOT.test(model) && catalogued.has(model.replace(SNAPSHOT, ""))) {
      snapshots.push(model);
      continue;
    }
    const first = rows[0] as PricedRow;
    gaps.push({
      model,
      tiers: rows.map((row) => row.tier),
      url: first.url,
      observedAt: rows.reduce(
        (earliest, row) => (row.observed_at < earliest ? row.observed_at : earliest),
        first.observed_at,
      ),
    });
  }
  return { priced: byModel.size, catalogued: catalogued.size, snapshots, gaps };
}
