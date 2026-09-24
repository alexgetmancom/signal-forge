import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { clearCredentialCircuit, openCredentialCircuitIds, recordCredentialRejection } from "../src/credentials.js";
import { buildOperationsGuide, OPERATION_SECTIONS } from "../src/guide.js";
import { listOperatorActions, recordOperatorAction } from "../src/journal.js";
import { callOperation, cliCommand, operationCatalog, operations } from "../src/operations.js";
import { lockHolder, withActionLock } from "../src/runtime/actionLock.js";
import { openDatabase } from "../src/storage/database.js";
import { storeSnapshot } from "../src/storage/snapshots.js";

const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
const testConfig = () => loadConfig({ CONFIG_PATH: configPath, BACKUP_DIRECTORY: "./tests/fixtures/backups" });

test("every operation reaches the surfaces it declares, and its usage is generated from its arguments", () => {
  const db = openDatabase(":memory:");
  const defs = operations(db, testConfig());
  for (const [name, definition] of Object.entries(defs)) {
    expect(OPERATION_SECTIONS).toContain(definition.section);
    expect(definition.summary.endsWith(".")).toBe(true);
    // An operation nobody can run is a definition, not an operation.
    expect(Boolean(definition.cli || definition.http)).toBe(true);
    // A mutation that touches credentials or the host is never an agent tool.
    if (definition.section === "host" && definition.mutates) expect(definition.agent).toBe(false);
    expect(cliCommand(name)).not.toContain("_");
  }
  const catalog = operationCatalog(defs);
  expect(catalog.find((entry) => entry.name === "resolve-delivery-verification")?.usage).toBe(
    "resolve-delivery-verification <id> <outcome> [external-id]",
  );
  expect(catalog.find((entry) => entry.name === "model")?.usage).toBe("model <canonical-id>");
  db.close();
});

test("the guide answers with sections and a symptom index before it answers with commands", () => {
  const db = openDatabase(":memory:");
  const defs = operations(db, testConfig());
  const guide = buildOperationsGuide(operationCatalog(defs));
  expect(guide.commands).toBeUndefined();
  expect(guide.sections.map((section) => section.section)).toEqual([...OPERATION_SECTIONS]);
  expect(guide.symptoms.length).toBeGreaterThan(4);
  expect(guide.symptoms.every((entry) => entry.usage.startsWith(entry.command))).toBe(true);
  const delivery = buildOperationsGuide(operationCatalog(defs), { section: "delivery" });
  expect(delivery.commands?.every((entry) => entry.section === "delivery")).toBe(true);
  db.close();
});

test("mutating operations are journalled with the surface that ran them", () => {
  const db = openDatabase(":memory:");
  recordOperatorAction(db, {
    surface: "cli",
    operation: "resolve_delivery_verification",
    input: { id: 7, outcome: "sent" },
    outcome: "ok",
  });
  recordOperatorAction(db, {
    surface: "mcp",
    operation: "require_delivery_verification",
    input: { id: 7 },
    outcome: "failed",
    detail: "gone",
  });
  const entries = listOperatorActions(db, { limit: 10 });
  expect(entries.map((entry) => [entry.surface, entry.operation, entry.outcome])).toEqual([
    ["mcp", "require_delivery_verification", "failed"],
    ["cli", "resolve_delivery_verification", "ok"],
  ]);
  expect(entries[1]?.input).toEqual({ id: 7, outcome: "sent" });
  expect(listOperatorActions(db, { limit: 10, operation: "require_delivery_verification" })).toHaveLength(1);
  db.close();
});

test("one holder at a time, and a lease outlives a holder that died", async () => {
  const db = openDatabase(":memory:");
  let inside = 0;
  const first = await withActionLock(db, "collection", lockHolder("a"), 60_000, async () => {
    inside += 1;
    const second = await withActionLock(db, "collection", lockHolder("b"), 60_000, () => {
      inside += 1;
      return "ran";
    });
    expect(second.acquired).toBe(false);
    return second;
  });
  expect(first.acquired).toBe(true);
  expect(inside).toBe(1);
  // The row a crashed holder left behind is taken over once its lease has passed.
  db.query(
    "INSERT INTO action_locks(name,holder,acquired_at,expires_at) VALUES('collection','dead','2020-01-01T00:00:00.000Z','2020-01-01T00:05:00.000Z')",
  ).run();
  const afterExpiry = await withActionLock(db, "collection", lockHolder("c"), 60_000, () => "ran");
  expect(afterExpiry.acquired).toBe(true);
  expect(db.query("SELECT COUNT(*) AS count FROM action_locks").get()).toEqual({ count: 0 });
  db.close();
});

test("a refused credential stops its sources and is cleared only by the owner", () => {
  const db = openDatabase(":memory:");
  recordCredentialRejection(db, {
    capabilityId: "github",
    source: "github-codex-commits",
    statusCode: 401,
    detail: "Source returned HTTP 401",
  });
  recordCredentialRejection(db, {
    capabilityId: "github",
    source: "github-codex-releases",
    statusCode: 401,
    detail: "Source returned HTTP 401",
  });
  expect(openCredentialCircuitIds(db)).toEqual(new Set(["github"]));
  const circuits = callOperation(operations(db, testConfig()), "credential_circuits") as { rejections: number }[];
  // The credential was refused twice; it opened once.
  expect(circuits).toEqual([expect.objectContaining({ capabilityId: "github", rejections: 2, statusCode: 401 })]);
  expect(clearCredentialCircuit(db, "github").state).toBe("cleared");
  expect(openCredentialCircuitIds(db).size).toBe(0);
  expect(() => clearCredentialCircuit(db, "github")).toThrow(/No open credential circuit/);
  db.close();
});

test("the database is readable by hand, and only readable", () => {
  const file = `${process.env.TMPDIR ?? "/tmp"}/sql-${Bun.randomUUIDv7()}.db`;
  const db = openDatabase(file);
  const defs = operations(db, { ...testConfig(), DATABASE_URL: file });
  storeSnapshot(db, "openrouter", "2026-09-24T10:00:00.000Z", '{"data":[{"id":"gpt-6-astra"}]}');

  // A blob is what a question about stored evidence runs into first: it is gzip, and printing the
  // bytes is what sent an investigation to a script on the host instead.
  const answer = callOperation(defs, "sql", { query: "SELECT source, body FROM snapshots" }) as {
    rows: { source: string; body: string }[];
    truncated: boolean;
  };
  expect(answer.rows[0]?.source).toBe("openrouter");
  expect(answer.rows[0]?.body).toBe('{"data":[{"id":"gpt-6-astra"}]}');
  expect(answer.truncated).toBe(false);
  // The limit is the rows taken, not a clause appended to somebody's query.
  expect(
    (callOperation(defs, "sql", { query: "SELECT 1 UNION SELECT 2", limit: 1 }) as { truncated: boolean }).truncated,
  ).toBe(true);

  // The guarantee is the connection, not a reading of the text: a write fails rather than lands.
  expect(() => callOperation(defs, "sql", { query: "DELETE FROM snapshots" })).toThrow(/readonly/);
  expect(db.query("SELECT COUNT(*) AS n FROM snapshots").get()).toEqual({ n: 1 });

  const schema = callOperation(defs, "schema", { table: "snapshots" }) as { table: string; columns: string[] }[];
  expect(schema).toHaveLength(1);
  expect(schema[0]?.columns).toContain("collected_at TEXT NOT NULL");
  expect(() => callOperation(defs, "schema", { table: "nope" })).toThrow(/No such table/);

  const snapshot = callOperation(defs, "snapshot", { source: "openrouter" }) as { body: string };
  expect(snapshot.body).toBe('{"data":[{"id":"gpt-6-astra"}]}');
  expect(callOperation(defs, "snapshot", { source: "nobody" })).toBeNull();
  db.close();
});
