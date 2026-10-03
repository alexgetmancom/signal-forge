import { expect, test } from "bun:test";
import { collectClaudeModelCatalog } from "../src/sources/modelCatalog.js";
import { openDatabase } from "../src/storage/database.js";
import { storeSnapshot } from "../src/storage/snapshots.js";

/**
 * A real catalogue and the real signature published beside it, kept whole because the signature is
 * over its exact bytes and a trimmed copy could not be checked at all. Version 1609, read
 * 2026-10-03; `now` is pinned inside its validity so the fixture does not expire the test.
 *
 * Both files are excluded from the formatter in `biome.json`. Reindenting them is a one-character
 * change to the bytes that were signed, and the whole suite then fails on a signature that is fine.
 */
const BODY = await Bun.file(new URL("./fixtures/claudeModelCatalog.json", import.meta.url)).text();
const SIGNATURE = await Bun.file(new URL("./fixtures/claudeModelCatalog.sig.json", import.meta.url)).text();
const NOW = Date.parse("2026-10-03T09:00:00Z");

const serving = (body: string, signature: string) =>
  (async (url: string | URL) =>
    new Response(String(url).endsWith(".raw-sig.json") ? signature : body)) as unknown as typeof fetch;

test("the client catalogue is read as what a surface offers, once per model", async () => {
  const db = openDatabase(":memory:");
  const collection = await collectClaudeModelCatalog(db, serving(BODY, SIGNATURE), NOW);
  const byId = new Map(collection.records.map((record) => [record.id, record]));

  // Thirteen models and five surfaces, not thirteen times five: a model reaching a sixth surface is
  // the same model, and one release must not be five cards.
  expect(collection.records).toHaveLength(18);
  expect(byId.get("claude-opus-5-5")).toMatchObject({
    name: "Opus 5.5",
    offeredOn: ["cc", "ccd", "ccr", "chat", "cowork"],
    sections: ["main"],
  });
  // Which surfaces offer a model is the part that moves on its own, and the part no other source
  // here answers: this one is offered to two clients of the five.
  expect(byId.get("claude-opus-4-1-20250805")).toMatchObject({ offeredOn: ["cc", "ccd"] });
  expect(byId.get("surface:chat")).toMatchObject({ defaultModel: "claude-sonnet-4-6" });
});

test("a catalogue is believed because of the key it was signed with, and for nothing else", async () => {
  const db = openDatabase(":memory:");
  const tampered = BODY.replace("claude-opus-5-5", "claude-opus-9-9");
  expect(tampered).not.toBe(BODY);
  await expect(collectClaudeModelCatalog(db, serving(tampered, SIGNATURE), NOW)).rejects.toThrow(
    "signature does not verify",
  );

  // A signature naming a key this service does not hold is a rotation, and a rotation is read out
  // of the distribution by somebody rather than accepted from the document that would benefit.
  const rotated = JSON.stringify({ ...JSON.parse(SIGNATURE), publicKeySha256: "00".repeat(32) });
  await expect(collectClaudeModelCatalog(db, serving(BODY, rotated), NOW)).rejects.toThrow("does not hold");
});

test("an expired catalogue and an older one are both refused, by their own kinds", async () => {
  const db = openDatabase(":memory:");
  const afterExpiry = Date.parse("2026-11-01T00:00:00Z");
  await expect(collectClaudeModelCatalog(db, serving(BODY, SIGNATURE), afterExpiry)).rejects.toThrow("expired");

  // A CDN serving yesterday's document would otherwise retire every model published since.
  storeSnapshot(db, "claude-model-catalog", "2026-10-03T08:00:00.000Z", JSON.stringify({ version: 2000 }));
  const error = await collectClaudeModelCatalog(db, serving(BODY, SIGNATURE), NOW).catch((e) => e);
  expect(error.kind).toBe("degraded");
  expect(error.message).toContain("391 versions");
});
