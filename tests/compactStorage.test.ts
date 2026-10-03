import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { storageOperations } from "../src/operations/storage.js";
import { compactStorage } from "../src/storage/compact.js";
import { openDatabase } from "../src/storage/database.js";
import { readSnapshot, storeSnapshot } from "../src/storage/snapshots.js";
import { anAttempt, anEvent, aSnapshot } from "./fixtures/build.js";

const directory = mkdtempSync(join(tmpdir(), "signal-forge-compact-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

test("the existing compact operation repacks retained gzip snapshots and reports it", async () => {
  const db = openDatabase(join(directory, "gzip.db"));
  const text = JSON.stringify({ name: "retained", rules: "official release".repeat(2000) });
  const snapshot = storeSnapshot(db, "polymarket", new Date().toISOString(), text);
  db.query("UPDATE snapshots SET body=? WHERE id=?").run(Bun.gzipSync(Buffer.from(text)), snapshot.id);
  const config = loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname });
  const operation = storageOperations(db, config).compact_storage;
  if (!operation) throw new Error("Compact operation missing");

  expect(await operation.handler({} as never)).toMatchObject({ repacked: { snapshots: 1, cacheEntries: 0 } });
  expect(
    db.query("SELECT hex(substr(body,1,4)) AS magic,hash,bytes FROM snapshots WHERE id=?").get(snapshot.id),
  ).toEqual({ magic: "28B52FFD", hash: snapshot.hash, bytes: snapshot.bytes });
  expect(readSnapshot(db, snapshot.id)).toBe(text);
  db.close();
});

test("compacting prunes successful details and trims old catalogs in the same operation", () => {
  const db = openDatabase(join(directory, "catalogs.db"));
  const now = Date.now();
  for (let index = 0; index < 6; index++)
    anAttempt(db, "openrouter", null, new Date(now - 10 * 86_400_000 + index).toISOString());
  for (let index = 0; index < 5; index++) anAttempt(db, "openrouter", null, new Date(now + index).toISOString());
  const days = db.query("SELECT * FROM source_collection_days ORDER BY day,source,outcome").all();
  const instant = new Date(now).toISOString();
  const router = storeSnapshot(
    db,
    "openrouter",
    instant,
    JSON.stringify({
      data: [
        {
          id: "model",
          name: "Model",
          created: 1,
          context_length: 100,
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          pricing: { prompt: "0" },
          description: "Unused",
        },
      ],
    }),
  );
  const gateway = storeSnapshot(
    db,
    "vercel-gateway",
    instant,
    JSON.stringify(
      JSON.stringify({
        data: [{ id: "model", description: "Unused" }],
      }),
    ),
  );
  anEvent(db, { snapshotId: router.id });
  anEvent(db, { snapshotId: gateway.id });
  const events = db.query("SELECT * FROM events ORDER BY id").all();

  const result = compactStorage(db);

  expect(result).toMatchObject({ removedCollectionMetrics: 6, trimmedCatalogs: { snapshots: 2 } });
  expect(db.query("SELECT * FROM source_collection_days ORDER BY day,source,outcome").all()).toEqual(days);
  expect(db.query("SELECT * FROM events ORDER BY id").all()).toEqual(events);
  expect(JSON.parse(readSnapshot(db, router.id) as string).data[0]).not.toHaveProperty("description");
  expect(JSON.parse(readSnapshot(db, gateway.id) as string)).toEqual({ data: [{ id: "model" }] });
  expect(compactStorage(db)).toMatchObject({ removedCollectionMetrics: 0, trimmedCatalogs: { snapshots: 0 } });
  db.close();
});

/**
 * A VACUUM in WAL mode writes the rebuilt database through the log, so without a truncating
 * checkpoint it leaves a `-wal` file as large as the database and the directory grows while the
 * report claims a saving. Production returned 32 MB of pages and was left with a 258 MB log.
 */
test("compacting returns the write-ahead log to the filesystem, not only the pages to the file", () => {
  const path = join(directory, "app.db");
  const db = openDatabase(path);
  // Enough payload that the VACUUM has something to rebuild and the log has something to hold.
  for (let index = 0; index < 400; index++) aSnapshot(db, { body: "x".repeat(20_000) });
  db.exec("DELETE FROM snapshots");

  const result = compactStorage(db);

  expect(result.walCheckpoint).toBe("truncated");
  expect(result.afterWalBytes).toBe(0);
  expect(statSync(`${path}-wal`).size).toBe(0);
  // The disk figure never claims more than the file figure did on its own.
  expect(result.releasedDiskBytes).toBeGreaterThanOrEqual(result.releasedBytes);
  db.close();
});
