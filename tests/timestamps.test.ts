import { expect, test } from "bun:test";
import { openDatabase } from "../src/storage/database.js";
import { dateIntegrity } from "../src/storage/dateIntegrity.js";
import { TIMESTAMP_COLUMNS } from "../src/storage/timestamps.js";

/**
 * The list, the triggers and the schema are three statements of the same fact. A timestamp column
 * added without the other two is exactly the column that will later hold a local-time string.
 */
test("every stored text timestamp column is covered by the list and by a trigger", () => {
  const db = openDatabase(":memory:");
  const declared = new Set(TIMESTAMP_COLUMNS.map(([table, column]) => `${table}.${column}`));
  const inSchema = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .flatMap((table) =>
      db
        .query<{ name: string; type: string }, []>(`PRAGMA table_info(${table.name})`)
        .all()
        .filter((column) => column.type === "TEXT" && column.name.endsWith("_at"))
        .map((column) => `${table.name}.${column.name}`),
    );
  const triggers = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='trigger'")
      .all()
      .map((row) => row.name),
  );
  for (const column of inSchema) {
    // The circuit and journal tables carry their own triggers written beside their own schema.
    if (
      column.startsWith("credential_circuits.") ||
      column.startsWith("action_locks.") ||
      column.startsWith("operator_journal.")
    )
      continue;
    expect(declared).toContain(column);
  }
  for (const [table, column] of TIMESTAMP_COLUMNS) expect(triggers).toContain(`${table}_${column}_shape_insert`);
  db.close();
});

test("a timestamp that is not ISO-8601 UTC is refused on write", () => {
  const db = openDatabase(":memory:");
  expect(() =>
    db.query("INSERT INTO summaries(event_id,text,created_at) VALUES(1,'x','Thu, Aug 20 2026')").run(),
  ).toThrow(/summaries.created_at must be an ISO-8601 UTC instant/);
  expect(() =>
    db.query("INSERT INTO summaries(event_id,text,created_at) VALUES(1,'x','2026-08-20T10:00:00+03:00')").run(),
  ).toThrow(/ISO-8601 UTC/);
  db.close();
});

test("date integrity reports rows written before the shape was enforced", () => {
  const db = openDatabase(":memory:");
  expect(dateIntegrity(db).ok).toBe(true);
  db.exec("DROP TRIGGER sources_checked_at_shape_insert");
  db.query("INSERT INTO sources(id,checked_at) VALUES('openai','2026-08-20')").run();
  const report = dateIntegrity(db);
  expect(report.ok).toBe(false);
  expect(report.violations).toEqual([
    expect.objectContaining({ table: "sources", column: "checked_at", rows: 1, samples: ["2026-08-20"] }),
  ]);
  db.close();
});
