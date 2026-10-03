import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactStorage } from "../src/storage/compact.js";
import { openDatabase } from "../src/storage/database.js";
import { aSnapshot } from "./fixtures/build.js";

const directory = mkdtempSync(join(tmpdir(), "signal-forge-compact-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

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

  expect(result.afterWalBytes).toBe(0);
  expect(statSync(`${path}-wal`).size).toBe(0);
  // The disk figure never claims more than the file figure did on its own.
  expect(result.releasedDiskBytes).toBeGreaterThanOrEqual(result.releasedBytes);
  db.close();
});
