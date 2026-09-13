import { expect, test } from "bun:test";
import { openDatabase } from "../src/storage/database.js";
import { dateIntegrity } from "../src/storage/dateIntegrity.js";
import { TIMESTAMP_COLUMNS } from "../src/storage/timestamps.js";

/**
 * The list, the constraint and the schema are three statements of the same fact. A timestamp
 * column added without the other two is exactly the column that will later hold a local-time
 * string.
 */
test("every stored text timestamp column is covered by the list and by a constraint", () => {
  const db = openDatabase(":memory:");
  const declared = new Set(TIMESTAMP_COLUMNS.map(([table, column]) => `${table}.${column}`));
  const tables = db
    .query<{ name: string; sql: string }, []>(
      "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  const inSchema = tables.flatMap((table) =>
    db
      .query<{ name: string; type: string }, []>(`PRAGMA table_info(${table.name})`)
      .all()
      .filter((column) => column.type === "TEXT" && column.name.endsWith("_at"))
      .map((column) => `${table.name}.${column.name}`),
  );
  for (const column of inSchema) expect(declared).toContain(column);
  const schemaByTable = new Map(tables.map((table) => [table.name, table.sql]));
  // A nullable column says "IS NULL OR" first; both spellings end in the same GLOB.
  for (const [table, column] of TIMESTAMP_COLUMNS)
    expect(schemaByTable.get(table)).toMatch(new RegExp(`CHECK\\((?:${column} IS NULL OR )?${column} GLOB '\\[0-9\\]`));
  db.close();
});

test("a timestamp that is not ISO-8601 UTC is refused on write", () => {
  const db = openDatabase(":memory:");
  expect(() =>
    db.query("INSERT INTO summaries(event_id,text,created_at) VALUES(1,'x','Thu, Aug 20 2026')").run(),
  ).toThrow(/CHECK constraint failed: created_at/);
  expect(() =>
    db.query("INSERT INTO summaries(event_id,text,created_at) VALUES(1,'x','2026-08-20T10:00:00+03:00')").run(),
  ).toThrow(/CHECK constraint failed: created_at/);
  db.close();
});

test("date integrity reports rows written before the shape was enforced", () => {
  const db = openDatabase(":memory:");
  expect(dateIntegrity(db).ok).toBe(true);
  // What a row written before the constraint existed looks like: the pragma is the only way in.
  db.exec("PRAGMA ignore_check_constraints=ON");
  db.query("INSERT INTO sources(id,checked_at) VALUES('openai','2026-08-20')").run();
  db.exec("PRAGMA ignore_check_constraints=OFF");
  const report = dateIntegrity(db);
  expect(report.ok).toBe(false);
  expect(report.violations).toEqual([
    expect.objectContaining({ table: "sources", column: "checked_at", rows: 1, samples: ["2026-08-20"] }),
  ]);
  db.close();
});
