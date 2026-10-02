import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { pricedUncatalogued } from "../src/reports/pricedUncatalogued.js";
import { openDatabase } from "../src/storage/database.js";

function aRecord(db: Database, source: string, id: string, body: Record<string, unknown>): void {
  db.query("INSERT INTO records(source,id,body,stream,observed_at) VALUES(?,?,?,'api-models',?)").run(
    source,
    id,
    JSON.stringify(body),
    "2026-10-02T12:00:00.000Z",
  );
}

function priced(db: Database, model: string, tier: string): void {
  aRecord(db, "openai-pricing", `${tier}:${model}`, {
    model,
    tier,
    url: "https://developers.openai.com/api/docs/pricing",
  });
}

test("a priced model neither catalogue lists is a gap, and a dated build of a catalogued one is not", () => {
  const db = openDatabase(":memory:");
  aRecord(db, "openai-model-index", "gpt-6-sol", { id: "gpt-6-sol" });
  aRecord(db, "openai", "gpt-4", { id: "gpt-4" });
  priced(db, "gpt-6-sol", "Standard");
  // Priced because fine-tuning still accepts it; the catalogues list the base model.
  priced(db, "gpt-4-0613", "Standard");
  // Priced, published nowhere: the finding this report exists for.
  priced(db, "gpt-rosalind-research", "Standard");
  priced(db, "gpt-rosalind-research", "Batch");

  const report = pricedUncatalogued(db);
  expect(report).toMatchObject({ priced: 3, catalogued: 2, snapshots: ["gpt-4-0613"] });
  expect(report.gaps).toEqual([
    {
      model: "gpt-rosalind-research",
      tiers: ["Batch", "Standard"],
      url: "https://developers.openai.com/api/docs/pricing",
      observedAt: "2026-10-02T12:00:00.000Z",
    },
  ]);
});

test("a dated build whose base is uncatalogued too is the same finding, not a snapshot", () => {
  const db = openDatabase(":memory:");
  priced(db, "gpt-5.5-cyber-2026-09-01", "Standard");
  const report = pricedUncatalogued(db);
  expect(report.snapshots).toEqual([]);
  expect(report.gaps.map((gap) => gap.model)).toEqual(["gpt-5.5-cyber-2026-09-01"]);
});
