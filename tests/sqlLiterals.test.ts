import { describe, expect, test } from "bun:test";
import { literals, STARTS } from "../scripts/sqlLiterals.js";

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
