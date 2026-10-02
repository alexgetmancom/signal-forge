import { describe, expect, test } from "bun:test";
import { squash } from "../scripts/squashMigrations.js";
import type { Migration } from "../src/storage/migrations.js";

function migration(version: number, name: string, sql: string): Migration {
  return { version, name, filename: `${String(version).padStart(3, "0")}_${name}.sql`, sql };
}

/** A baseline, a column and an index, a rebuilt table with a remark inside it, and one that has not shipped. */
const journal: Migration[] = [
  migration(
    3,
    "baseline",
    "CREATE TABLE owners(id INTEGER PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE pets(id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES owners(id));",
  ),
  migration(4, "kind", "ALTER TABLE owners ADD COLUMN kind TEXT; CREATE INDEX owners_kind ON owners(kind);"),
  migration(
    5,
    "rebuild_pets",
    `CREATE TABLE pets2(
       id INTEGER PRIMARY KEY,
       -- Whose it is; deleting an owner takes the pets, and that is deliberate.
       owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
       note TEXT CHECK(note IS NULL OR note NOT IN ('a,b', 'c(d')) -- a comma and a parenthesis in a string
     );
     INSERT INTO pets2(id, owner_id) SELECT id, owner_id FROM pets WHERE owner_id IS NOT NULL;
     DROP TABLE pets;
     ALTER TABLE pets2 RENAME TO pets;
     CREATE INDEX pets_owner ON pets(owner_id) WHERE note IS NULL;`,
  ),
  migration(6, "toys", "CREATE TABLE toys(id INTEGER PRIMARY KEY, pet_id INTEGER REFERENCES pets(id));"),
];

describe("squashing a journal", () => {
  test("everything up to a version becomes one file numbered for it, and what is above stays", () => {
    const result = squash(journal, 5);
    expect(result.filename).toBe("005_baseline.sql");
    expect(result.replaces.map((one) => one.version)).toEqual([3, 4, 5]);
    expect(result.kept.map((one) => one.version)).toEqual([6]);
    expect(result.sql).toContain("-- Migrations 003 to 005 were squashed");
    expect(result.sql.trimEnd().endsWith("ANALYZE;")).toBe(true);
  });

  test("a column added later is in the table, and the remarks inside a table are kept", () => {
    const { sql } = squash(journal, 5);
    expect(sql).toContain("CREATE TABLE owners (\n  id INTEGER PRIMARY KEY,\n  name TEXT NOT NULL,\n  kind TEXT\n);");
    expect(sql).toContain("-- Whose it is; deleting an owner takes the pets, and that is deliberate.");
    expect(sql).toContain("-- a comma and a parenthesis in a string");
    // Rebuilding a table left no trace of the name it was rebuilt from.
    expect(sql).not.toContain("pets2");
  });

  test("tables come parents first and each table's indexes follow it", () => {
    const { sql } = squash(journal, 6);
    const at = (text: string) => sql.indexOf(text);
    expect(at("CREATE TABLE owners")).toBeLessThan(at("CREATE TABLE pets"));
    expect(at("CREATE TABLE pets")).toBeLessThan(at("CREATE TABLE toys"));
    expect(at("CREATE INDEX owners_kind")).toBeLessThan(at("CREATE TABLE pets"));
    expect(sql).toContain("CREATE INDEX pets_owner ON pets(owner_id) WHERE note IS NULL;");
  });

  test("squashing a squash keeps the order the tables already had", () => {
    const first = squash(journal, 5);
    const again = squash([migration(5, "baseline", first.sql), ...first.kept], 6);
    expect(again.filename).toBe("006_baseline.sql");
    expect(again.sql).toContain("-- Migrations 005 to 006 were squashed");
    expect(again.sql.indexOf("CREATE TABLE owners")).toBeLessThan(again.sql.indexOf("CREATE TABLE toys"));
  });
});

describe("what it refuses", () => {
  test("a version that is already the baseline, or that does not exist", () => {
    expect(() => squash(journal, 3)).toThrow("already the baseline");
    expect(() => squash(journal, 9)).toThrow("no migration 9");
    expect(() => squash([], 1)).toThrow("no migration 1");
  });

  test("a journal that leaves rows behind, because a baseline carries the schema and not data", () => {
    const seeded = [...journal, migration(7, "seed", "INSERT INTO owners(id, name) VALUES (1, 'a');")];
    expect(() => squash(seeded, 7)).toThrow("leaves 1 rows in owners");
  });

  test("a trigger or a view, which would be dropped without a word", () => {
    const withView = [...journal, migration(7, "view", "CREATE VIEW named AS SELECT name FROM owners;")];
    expect(() => squash(withView, 7)).toThrow("creates a view, named");
  });
});
