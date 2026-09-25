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
  expect(guide.conventions.length).toBeGreaterThan(2);
  db.close();
});

test("one word is a section or a command, whichever it names", () => {
  const db = openDatabase(":memory:");
  const catalog = operationCatalog(operations(db, testConfig()));
  const one = buildOperationsGuide(catalog, { section: "broken" });
  expect(one.commands?.map((entry) => entry.name)).toEqual(["broken"]);
  expect(one.noSuchCommand).toBeUndefined();
  // Nobody arriving with a question knows whether the word they have is a section or a command,
  // and answering "expected one of health|delivery|evidence|sources|host" helped none of them.
  expect(buildOperationsGuide(catalog, { section: "brokn" }).noSuchCommand).toBe("brokn");
  db.close();
});

test("the commands AGENTS.md used to explain now explain themselves", () => {
  const db = openDatabase(":memory:");
  const catalog = operationCatalog(operations(db, testConfig()));
  // Each of these had a paragraph of its own in AGENTS.md -- how to read what it answers, which
  // field to read first, which mistake the raw table invites. That paragraph is the `note` now,
  // and this is what stops it going back to being prose nobody generates.
  for (const name of [
    "broken",
    "flaky",
    "outages",
    "failures",
    "timings",
    "usage",
    "destinations",
    "references",
    "sql",
    "schema",
  ]) {
    const entry = catalog.find((found) => found.name === name);
    expect(entry?.note?.length ?? 0, `${name} has no note`).toBeGreaterThan(120);
  }
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

test("a holder that loses its lease is told, and does not release the new holder's row", async () => {
  const db = openDatabase(":memory:");
  let toldWhileRunning = false;
  // Renewal runs on a floor of a second, so the wait has to outlast one of them.
  const outcome = await withActionLock(db, "collection", lockHolder("slow"), 4_000, async ({ signal, holder }) => {
    db.query("UPDATE action_locks SET holder='usurper' WHERE name='collection'").run();
    await Bun.sleep(1_300);
    toldWhileRunning = signal.aborted;
    return holder;
  });
  expect(outcome.acquired).toBe(true);
  // Without this the stalled holder keeps collecting the same sources the new one is collecting.
  expect(toldWhileRunning).toBe(true);
  // And its release matches on its own holder, so it cannot delete a lease it no longer owns.
  expect(db.query<{ holder: string }, []>("SELECT holder FROM action_locks").get()?.holder).toBe("usurper");
  db.close();
});

test("two acquisitions of one lease never share a holder string", () => {
  // Reconstructing the holder to fence a write was only ever correct while this was false, and a
  // container that restarts its processes at low pids makes it false across a crash.
  expect(lockHolder("poller")).not.toBe(lockHolder("poller"));
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

  // A wrong guess is answered with the names that would have been right, because "no such column"
  // on its own sends the next guess to production to be told nothing again.
  expect(() => callOperation(defs, "sql", { query: "SELECT summary FROM snapshots" })).toThrow(
    /no such column: summary\. Columns here: snapshots\(.*collected_at.*\)/,
  );
  expect(() => callOperation(defs, "sql", { query: "SELECT 1 FROM event_summaries" })).toThrow(
    /no such table: event_summaries\. Tables here: .*summaries/,
  );

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

test("a card that went out wrong can be sent again, carrying only its own event", () => {
  const db = openDatabase(":memory:");
  const defs = operations(db, testConfig());
  const at = "2026-09-24T13:40:30.000Z";
  const snapshot = storeSnapshot(db, "discovery:opencode-data", at, "{}");
  db.query(
    "INSERT INTO events(id,source,stream,kind,entity_id,detected_at,after_json,signal,snapshot_id) VALUES(1,?,?,?,?,?,?,?,?)",
  ).run(
    "discovery:opencode-data",
    "api-models",
    "new",
    "meta/muse-spark-1-4-contributor",
    at,
    "{}",
    "codename",
    snapshot.id,
  );
  db.query("INSERT INTO batches(id,source,digest,ready_at,sealed,kind) VALUES(1,?,0,?,1,'event')").run(
    "discovery:opencode-data",
    at,
  );
  db.query(
    "INSERT INTO deliveries(id,destination_id,destination_json,body,status,attempts,part,batch_id,next_attempt_at,updated_at) VALUES(1,?,?,?,'sent',1,0,1,?,?)",
  ).run("discord-scouts", '{"id":"discord-scouts"}', "{}", at, at);
  db.query("INSERT INTO delivery_events(delivery_id,event_id) VALUES(1,1)").run();

  const answer = callOperation(defs, "resend", { eventId: 1 }) as { destinations: string[]; batch: number };
  expect(answer.destinations).toEqual(["discord-scouts"]);
  // The card is queued the ordinary way: a batch the next delivery cycle picks up.
  expect(db.query("SELECT event_id FROM batch_events WHERE batch_id=?").get(answer.batch)).toEqual({ event_id: 1 });
  expect(db.query("SELECT destination_id FROM batch_targets WHERE batch_id=?").get(answer.batch)).toEqual({
    destination_id: "discord-scouts",
  });

  // Sharing a message with another event is the usual reason a card was wrong -- Muse Spark 1.4
  // went out beside a stale gpt-5-6 -- so it is resent, and the new card carries this event alone.
  db.query(
    "INSERT INTO events(id,source,stream,kind,entity_id,detected_at,after_json,signal,snapshot_id) VALUES(2,?,?,?,?,?,?,?,?)",
  ).run("discovery:opencode-data", "api-models", "new", "unknown/space-bunny", at, "{}", "codename", snapshot.id);
  db.query("INSERT INTO delivery_events(delivery_id,event_id) VALUES(1,2)").run();
  const again = callOperation(defs, "resend", { eventId: 1 }) as { batch: number };
  expect(db.query("SELECT event_id FROM batch_events WHERE batch_id=?").all(again.batch)).toEqual([{ event_id: 1 }]);

  // An event nothing ever delivered has nowhere to be sent again.
  db.query(
    "INSERT INTO events(id,source,stream,kind,entity_id,detected_at,after_json,signal,snapshot_id) VALUES(3,?,?,?,?,?,?,?,?)",
  ).run("discovery:opencode-data", "api-models", "new", "unknown/sonoma-sky", at, "{}", "codename", snapshot.id);
  expect(() => callOperation(defs, "resend", { eventId: 3 })).toThrow(/never delivered/);
  db.close();
});

test("every positional argument is a field its operation's schema knows", () => {
  const db = openDatabase(":memory:");
  const defs = operations(db, testConfig());
  // `resend` took `event-id` on the command line and `eventId` in its schema, so every value typed
  // after the command was dropped and the operation refused a number it had just been given. The
  // registry is the one place both spellings live; a name only one side knows is a typo.
  for (const [name, def] of Object.entries(defs)) {
    const shape = (def.schema as { shape?: Record<string, unknown> }).shape ?? {};
    for (const argument of def.cli?.args ?? [])
      expect({ [name]: argument.name }).toEqual({
        [name]: Object.keys(shape).includes(argument.name)
          ? argument.name
          : `${argument.name} is not a field of ${name}`,
      });
  }
  db.close();
});
