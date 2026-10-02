import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { buildSourceRegistry, recordSourceIdentities } from "../src/sources/registry.js";
import { openDatabase } from "../src/storage/database.js";
import { aSource } from "./fixtures/build.js";

const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
const config = () => loadConfig({ CONFIG_PATH: configPath });

const liveIds = (db: ReturnType<typeof openDatabase>) =>
  new Set(
    db
      .query<{ id: string }, []>("SELECT id FROM live_sources")
      .all()
      .map((row) => row.id),
  );

test("a source the registry does not name is stamped retired once, and is not in live_sources", () => {
  const db = openDatabase(":memory:");
  const definitions = buildSourceRegistry(db, config());
  aSource(db, "designarena:retired-board");

  // Until a boot has settled it, a row reads as live: nothing else can say which rows are retired.
  expect(liveIds(db).has("designarena:retired-board")).toBe(true);

  const first = "2026-10-02T10:00:00.000Z";
  expect(recordSourceIdentities(db, definitions, first)).toEqual(["designarena:retired-board"]);
  expect(liveIds(db).has("designarena:retired-board")).toBe(false);
  expect(db.query("SELECT retired_at FROM sources WHERE id=?").get("designarena:retired-board")).toEqual({
    retired_at: first,
  });

  // Every registered source is live, and the view is exactly them.
  expect(liveIds(db)).toEqual(new Set(definitions.map((definition) => definition.id)));

  // A later boot reports nothing new and keeps the instant it was first noticed.
  expect(recordSourceIdentities(db, definitions, "2026-10-03T10:00:00.000Z")).toEqual([]);
  expect(db.query("SELECT retired_at FROM sources WHERE id=?").get("designarena:retired-board")).toEqual({
    retired_at: first,
  });
  db.close();
});

test("a retired source the registry names again is live again, and its history is untouched", () => {
  const db = openDatabase(":memory:");
  const definitions = buildSourceRegistry(db, config());
  const comeback = { ...(definitions[0] as (typeof definitions)[number]), id: "pages:comes-back" };
  aSource(db, comeback.id, { lastSuccess: "2026-09-01T00:00:00.000Z", failures: 2 });

  expect(recordSourceIdentities(db, definitions, "2026-10-02T10:00:00.000Z")).toContain(comeback.id);
  expect(liveIds(db).has(comeback.id)).toBe(false);

  expect(recordSourceIdentities(db, [...definitions, comeback], "2026-10-04T10:00:00.000Z")).toEqual([]);
  expect(liveIds(db).has(comeback.id)).toBe(true);
  expect(db.query("SELECT retired_at,failures,last_success FROM sources WHERE id=?").get(comeback.id)).toEqual({
    retired_at: null,
    failures: 2,
    last_success: "2026-09-01T00:00:00.000Z",
  });
  db.close();
});

test("retired_at holds an instant in the shape every other timestamp here has, or nothing", () => {
  const db = openDatabase(":memory:");
  aSource(db, "pages:odd");
  expect(() => db.query("UPDATE sources SET retired_at='yesterday' WHERE id='pages:odd'").run()).toThrow();
  db.close();
});
