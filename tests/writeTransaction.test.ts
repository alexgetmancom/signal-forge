import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/database.js";
import { writeTransaction } from "../src/storage/transaction.js";

let directory = "";
let path = "";
let db: Database;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "signal-forge-lock-"));
  path = join(directory, "app.db");
  db = openDatabase(path);
  db.exec("CREATE TABLE held(x TEXT); CREATE TABLE stored(x TEXT)");
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

/** Another process takes the write lock, and this resolves once it has it and for how long it keeps it. */
async function otherWriterHolds(milliseconds: number): Promise<{ released: Promise<unknown> }> {
  const holder = Bun.spawn(
    [process.execPath, join(import.meta.dir, "fixtures/holdWriteLock.ts"), path, String(milliseconds)],
    {
      stdout: "pipe",
    },
  );
  const reader = holder.stdout.getReader();
  await reader.read();
  return { released: holder.exited };
}

/** What a collection's transaction does first: look at the store, and only then write to it. */
function readThenWrite(): number {
  db.query("SELECT COUNT(*) FROM stored").get();
  db.query("INSERT INTO stored(x) VALUES('the collection')").run();
  return 1;
}

test("a transaction that reads before it writes is refused at once while another process is writing", async () => {
  // The reason `writeTransaction` exists. A deferred BEGIN takes its read snapshot with the first
  // statement, and a snapshot that cannot be upgraded to a write is refused without ever calling the
  // busy handler -- so the five seconds `busy_timeout` promises are not spent, and a source whose
  // collection was fine goes red. Sixteen of them in a week on production.
  const other = await otherWriterHolds(500);
  const started = Date.now();
  expect(() => db.transaction(readThenWrite)()).toThrow("database is locked");
  expect(Date.now() - started).toBeLessThan(400);
  await other.released;
});

test("a write transaction waits for the other writer and then commits", async () => {
  const other = await otherWriterHolds(500);
  const started = Date.now();
  expect(writeTransaction(db, readThenWrite)).toBe(1);
  expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  await other.released;
  expect(db.query("SELECT COUNT(*) AS n FROM stored").get()).toEqual({ n: 1 });
  expect(db.query("SELECT COUNT(*) AS n FROM held").get()).toEqual({ n: 1 });
});

test("a write transaction that throws leaves nothing behind, and a nested one rolls back with it", () => {
  expect(() =>
    writeTransaction(db, () => {
      db.query("INSERT INTO stored(x) VALUES('outer')").run();
      writeTransaction(db, () => db.query("INSERT INTO stored(x) VALUES('inner')").run());
      throw new Error("the collection was refused");
    }),
  ).toThrow("the collection was refused");
  expect(db.query("SELECT COUNT(*) AS n FROM stored").get()).toEqual({ n: 0 });
  expect(db.inTransaction).toBe(false);
});
