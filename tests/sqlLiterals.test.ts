import { describe, expect, test } from "bun:test";
import { literals, readsEventBodies, STARTS } from "../scripts/sqlLiterals.js";

const sql = (text: string) =>
  literals(text)
    .map((found) => found.value)
    .filter((value) => STARTS.test(value));

describe("the SQL written in a file", () => {
  test("a quote inside a statement does not end it", () => {
    expect(sql(`db.query("SELECT id FROM sources WHERE kind = 'schema' AND id = ?")`)).toEqual([
      "SELECT id FROM sources WHERE kind = 'schema' AND id = ?",
    ]);
  });

  test("a spliced fragment becomes a parameter", () => {
    // Written by hand rather than as a template, because the point is the `${...}` in the file.
    const opened = ["db.query(`SELECT id FROM stories WHERE id IN (", "$", "{ids})`)"].join("");
    expect(sql(opened)).toEqual(["SELECT id FROM stories WHERE id IN (?)"]);
  });

  test("a statement commented out is not a statement", () => {
    expect(sql('// db.query("SELECT nothing FROM nowhere");\nconst x = 1;')).toEqual([]);
    expect(sql('/* was: db.query("SELECT nothing FROM nowhere") */\nconst x = 1;')).toEqual([]);
  });

  test("a line is the one the statement opens on", () => {
    const text = ["const a = 1;", 'const b = "x";', "db.query(", '  "SELECT id FROM events",', ");"].join("\n");
    expect(literals(text).find((found) => STARTS.test(found.value))?.line).toBe(4);
  });

  test("a sentence that merely starts with a keyword is still offered, and SQLite is what refuses it", () => {
    // The scanner does not judge; `select` at the start of a comment-like string reaches the
    // parser, fails to parse, and is counted as assembled rather than reported as a wrong name.
    expect(sql('const note = "select the newest first";')).toEqual(["select the newest first"]);
  });
});

/**
 * The rule `check-sql` enforces with this: a read that carries event bodies is one of the reads
 * listed as carrying them. Every shape below is one the repository actually writes, and the pair
 * that matters is the first two -- the same question asked expensively and cheaply.
 */
describe("a read that takes event bodies", () => {
  test("selecting a body is one, extracting a key from it is not", () => {
    expect(readsEventBodies("SELECT after_json,detected_at FROM events WHERE detected_at>=?")).toBe(true);
    expect(
      readsEventBodies("SELECT json_extract(after_json,'$.name') AS name,detected_at FROM events WHERE detected_at>=?"),
    ).toBe(false);
    // The shape `identityColumns` generates, which is what the story list reads instead of 27.6 MB.
    expect(
      readsEventBodies(
        "SELECT CASE WHEN json_valid(COALESCE(e.after_json,e.before_json)) THEN " +
          "json_extract(COALESCE(e.after_json,e.before_json),'$.name') END AS ident_name FROM events e WHERE e.id<=?",
      ),
    ).toBe(false);
  });

  test("`*` from events is one, because it carries both bodies", () => {
    expect(readsEventBodies("SELECT * FROM events WHERE detected_at>=? ORDER BY id")).toBe(true);
    expect(readsEventBodies("SELECT e.*,be.url FROM batch_events be JOIN events e ON e.id=be.event_id")).toBe(true);
    expect(readsEventBodies("SELECT COUNT(*) n FROM events WHERE detected_at>=?")).toBe(false);
  });

  test("one event by its id is not one: a single body is not a floor", () => {
    expect(readsEventBodies("SELECT * FROM events WHERE id=?")).toBe(false);
    expect(readsEventBodies("SELECT id,source,before_json,after_json FROM events WHERE id=?")).toBe(false);
  });

  test("a write is not a read", () => {
    expect(readsEventBodies("INSERT INTO events(source,after_json) VALUES(?,?)")).toBe(false);
    expect(readsEventBodies("UPDATE events SET after_json=? WHERE id=?")).toBe(false);
  });
});
