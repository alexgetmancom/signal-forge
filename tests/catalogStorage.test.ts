import { expect, test } from "bun:test";
import { collectOpenRouter } from "../src/sources/catalogs.js";
import { parseVercelGateway } from "../src/sources/registries.js";
import { openDatabase } from "../src/storage/database.js";
import { trimCatalogSnapshots } from "../src/storage/repack.js";
import { readSnapshot, storeSnapshot } from "../src/storage/snapshots.js";
import { anEvent } from "./fixtures/build.js";

const instant = "2026-10-03T18:00:00.000Z";
const router = (created = 1) => ({
  data: [
    {
      id: "vendor/model",
      name: "Model",
      created,
      context_length: 100_000,
      pricing: { prompt: "0.000001", future_cost: "0.1" },
      architecture: { input_modalities: ["image", "text"], output_modalities: ["text"], tokenizer: "unused" },
      supported_parameters: ["tools"],
      description: "Unused metadata".repeat(2000),
    },
  ],
  total_count: 1,
});
const gateway = {
  object: "list",
  data: [
    {
      id: "vendor/model",
      name: "Model",
      owned_by: "vendor",
      context_window: 100_000,
      max_tokens: 4096,
      pricing: { input: "0.000001", future_cost: "0.1" },
      description: "Unused metadata".repeat(2000),
    },
  ],
};

test("old catalog bodies migrate to the collectors' evidence with receipts and event references consistent", async () => {
  const db = openDatabase(":memory:");
  const originals = [
    storeSnapshot(db, "openrouter", instant, JSON.stringify(router())),
    storeSnapshot(db, "vercel-gateway", instant, JSON.stringify(JSON.stringify(gateway))),
  ] as const;
  for (const snapshot of originals) anEvent(db, { snapshotId: snapshot.id });
  const events = db.query("SELECT * FROM events ORDER BY id").all();
  const projected = [
    await collectOpenRouter(async () => Response.json(router())),
    parseVercelGateway(JSON.stringify(gateway)),
  ] as const;

  expect(trimCatalogSnapshots(db).snapshots).toBe(2);
  for (let index = 0; index < originals.length; index++) {
    const id = originals[index]?.id as number;
    const raw = JSON.stringify(projected[index]?.raw);
    expect(readSnapshot(db, id)).toBe(raw);
    expect(db.query("SELECT hash,bytes,collected_at FROM snapshots WHERE id=?").get(id)).toEqual({
      hash: new Bun.CryptoHasher("sha256").update(raw).digest("hex"),
      bytes: Buffer.byteLength(raw),
      collected_at: instant,
    });
  }
  expect(db.query("SELECT * FROM events ORDER BY id").all()).toEqual(events);
  const replay = await collectOpenRouter(async () => new Response(readSnapshot(db, originals[0]?.id as number)));
  expect(replay.records).toEqual(projected[0]?.records);
  expect(parseVercelGateway(readSnapshot(db, originals[1]?.id as number) as string).records).toEqual(
    projected[1]?.records,
  );
  expect(storeSnapshot(db, "openrouter", instant, JSON.stringify(replay.raw)).id).toBe(originals[0]?.id);
  expect(trimCatalogSnapshots(db)).toEqual({ snapshots: 0, beforeBytes: 0, afterBytes: 0, freedBytes: 0 });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

test("a corrupt catalog rolls back its chunk and completed chunks remain resumable", () => {
  const db = openDatabase(":memory:");
  const ids = Array.from(
    { length: 12 },
    (_, index) =>
      storeSnapshot(
        db,
        "openrouter",
        instant,
        JSON.stringify(index === 11 ? { data: [{ id: "broken" }] } : router(index + 1)),
      ).id,
  );
  expect(() => trimCatalogSnapshots(db)).toThrow("could not be trimmed");
  expect(JSON.parse(readSnapshot(db, ids[0] as number) as string).data[0]).not.toHaveProperty("description");
  expect(JSON.parse(readSnapshot(db, ids[10] as number) as string).data[0]).toHaveProperty("description");
  const fixed = JSON.stringify(router(12));
  db.query("UPDATE snapshots SET body=? WHERE id=?").run(Bun.gzipSync(Buffer.from(fixed)), ids[11] as number);
  expect(trimCatalogSnapshots(db).snapshots).toBe(2);
  expect(trimCatalogSnapshots(db).snapshots).toBe(0);
  db.close();
});
