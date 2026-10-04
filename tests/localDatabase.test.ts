import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DATABASE_URL } from "../src/config.js";
import { missingDefaultDatabase } from "../src/storage/database.js";

test("the default path with no file behind it is refused rather than created empty", () => {
  // The failure this prevents is not a crash: it is a report that answers zero to everything out of
  // a database the migrations have just built, which reads exactly like a quiet day.
  const reason = missingDefaultDatabase(DEFAULT_DATABASE_URL);
  expect(reason).toContain("no local database");
  expect(reason).toContain("bun run prod");
});

test("a path somebody named on purpose is theirs, whether or not it exists yet", () => {
  // Production's own first boot is the legitimate case of a database that does not exist, and an
  // explicit --db is somebody who means that file. Neither may be refused.
  const directory = mkdtempSync(join(tmpdir(), "local-db-"));
  try {
    expect(missingDefaultDatabase(join(directory, "fresh.db"))).toBeNull();
    expect(missingDefaultDatabase(":memory:")).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the default path is allowed the moment a file is actually there", () => {
  // The repository is the working directory for the gate, so this would pass vacuously if the
  // refusal keyed on the name alone: it has to key on the file.
  const directory = mkdtempSync(join(tmpdir(), "local-db-"));
  try {
    const path = join(directory, "app.db");
    writeFileSync(path, "");
    expect(missingDefaultDatabase(path)).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
