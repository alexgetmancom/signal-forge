import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseCheck } from "../src/reports/release.js";
import { openDatabase } from "../src/storage/database.js";
import { CURRENT_SCHEMA_VERSION } from "../src/storage/migrations.js";

/** A build tree, because the point of the check is that it reads one and not the database. */
const BUILD = mkdtempSync(join(tmpdir(), "signal-forge-dist-"));
mkdirSync(join(BUILD, "sub"), { recursive: true });
writeFileSync(join(BUILD, "sub", "a.js"), "export const releaseCheck = 1;");
writeFileSync(join(BUILD, "b.js"), "const other = 2;");
afterAll(() => rmSync(BUILD, { recursive: true, force: true }));

test("a fresh database is at the schema version this build expects, with its hot-path indexes", () => {
  const db = openDatabase(":memory:");
  const check = releaseCheck(db, {});
  expect(check.schema).toEqual({ expected: CURRENT_SCHEMA_VERSION, applied: CURRENT_SCHEMA_VERSION, ok: true });
  // 049 shipped indexes that the planner ignored until ANALYZE ran; missing and unanalysed are
  // different failures and only one of them is visible in sqlite_master.
  expect(check.indexes.missing).toEqual([]);
  expect(check.symbol).toEqual({ name: null, found: null, files: [] });
  expect(check.ok).toBe(true);
  db.close();
});

test("a symbol the release added is looked for in the built code, not in the database", () => {
  const db = openDatabase(":memory:");
  // Every database check can pass while the container runs last week's image.
  const found = releaseCheck(db, { symbol: "releaseCheck", directory: BUILD });
  expect(found.symbol.found).toBe(true);
  expect(found.symbol.files).toEqual(["sub/a.js"]);
  expect(found.ok).toBe(true);

  const missing = releaseCheck(db, { symbol: "notInThisBuild", directory: BUILD });
  expect(missing.symbol.found).toBe(false);
  expect(missing.ok).toBe(false);
  db.close();
});

test("a build directory that is not there is a failed check, not a crash", () => {
  const db = openDatabase(":memory:");
  const check = releaseCheck(db, { symbol: "releaseCheck", directory: "/nonexistent/dist" });
  expect(check.symbol.found).toBe(false);
  expect(check.ok).toBe(false);
  db.close();
});

test("an index dropped after the migration ran is reported missing", () => {
  const db = openDatabase(":memory:");
  db.exec("DROP INDEX events_detected_at");
  const check = releaseCheck(db, {});
  expect(check.indexes.missing).toEqual(["events_detected_at"]);
  expect(check.ok).toBe(false);
  db.close();
});
