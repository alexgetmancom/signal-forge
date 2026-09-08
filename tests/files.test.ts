import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECRET_MODE, writeJsonAtomic, writeSecretJson, writeTextAtomic } from "../src/storage/files.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "boilerplate-files-"));
}

describe("atomic writes", () => {
  test("creates missing directories", () => {
    const path = join(scratch(), "nested", "deep", "note.txt");
    writeTextAtomic(path, "hello");
    expect(readFileSync(path, "utf8")).toBe("hello");
  });

  test("replaces existing content and leaves no temporary file behind", () => {
    const directory = scratch();
    const path = join(directory, "note.txt");
    writeFileSync(path, "old");
    writeTextAtomic(path, "new");
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(readdirSync(directory)).toEqual(["note.txt"]);
  });

  test("writes JSON with a trailing newline", () => {
    const path = join(scratch(), "data.json");
    writeJsonAtomic(path, { a: 1 });
    expect(readFileSync(path, "utf8")).toBe('{\n  "a": 1\n}\n');
  });

  test("secrets are owner-only", () => {
    const path = join(scratch(), "token.json");
    writeSecretJson(path, { token: "s3cret" });
    expect(statSync(path).mode & 0o777).toBe(SECRET_MODE);
  });

  test("a secret overwriting a world-readable file drops the old permissions", () => {
    const path = join(scratch(), "token.json");
    writeJsonAtomic(path, { token: "old" });
    writeSecretJson(path, { token: "new" });
    expect(statSync(path).mode & 0o777).toBe(SECRET_MODE);
  });
});
