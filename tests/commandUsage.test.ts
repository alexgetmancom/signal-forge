import { expect, test } from "bun:test";
import { recordOperatorAction } from "../src/journal.js";
import { queryShape, usageReport } from "../src/reports/usage.js";
import { openDatabase } from "../src/storage/database.js";

test("two askings of one question have one shape, and different questions do not", () => {
  const shape = queryShape("SELECT * FROM events WHERE source='openrouter' AND id > 100");
  expect(queryShape("SELECT  *\n  FROM events WHERE source='arena'   AND id > 4200")).toBe(shape);
  // The literals are what differ between askings; the columns are what make it a different question.
  expect(queryShape("SELECT source FROM events WHERE source='arena' AND id > 1")).not.toBe(shape);
});

test("a raw query asked twice is reported as a command that should exist", () => {
  const db = openDatabase(":memory:");
  const ask = (destination: string) =>
    recordOperatorAction(db, {
      surface: "cli",
      operation: "sql",
      input: { query: `SELECT COUNT(*) FROM deliveries WHERE destination_id='${destination}'` },
      outcome: "ok",
      mutates: false,
      durationMs: 3,
    });
  ask("discord-news");
  ask("discord-radar");
  recordOperatorAction(db, {
    surface: "cli",
    operation: "sql",
    input: { query: "SELECT 1" },
    outcome: "ok",
    mutates: false,
  });

  const report = usageReport(db);
  expect(report.window.calls).toBe(3);
  expect(report.commands).toEqual([{ operation: "sql", surface: "cli", calls: 3, failures: 0, maxMs: 3 }]);
  // Asked once is a one-off; asked twice about two different channels is a missing report.
  expect(report.askedByHand.map((entry) => entry.asked)).toEqual([2]);
  expect(report.askedByHand[0]?.shape).toContain("destination_id='?'");
  db.close();
});

test("reads are journalled but only mutations are what `journal` answers for", async () => {
  const db = openDatabase(":memory:");
  recordOperatorAction(db, { surface: "cli", operation: "sql", input: {}, outcome: "ok", mutates: false });
  recordOperatorAction(db, { surface: "cli", operation: "resend", input: {}, outcome: "ok" });
  const { listOperatorActions } = await import("../src/journal.js");
  expect(listOperatorActions(db, { limit: 10 }).map((entry) => entry.operation)).toEqual(["resend"]);
  expect(usageReport(db).window.calls).toBe(2);
  db.close();
});

test("a journalled argument that looks like a credential is stored redacted", () => {
  const db = openDatabase(":memory:");
  recordOperatorAction(db, {
    surface: "http",
    operation: "set_credential",
    input: { setting: "DISCORD_BOT_TOKEN", token: "sk-live-secret", nested: { apiKey: "sk-also-secret" } },
    outcome: "ok",
  });
  const stored = db.query<{ input_json: string }, []>("SELECT input_json FROM operator_journal").get()?.input_json;
  expect(stored).not.toContain("secret");
  // The name of the setting is the useful half and is never the sensitive one.
  expect(stored).toContain("DISCORD_BOT_TOKEN");
  expect(JSON.parse(stored ?? "{}").nested.apiKey).toBe("[REDACTED]");
  db.close();
});
