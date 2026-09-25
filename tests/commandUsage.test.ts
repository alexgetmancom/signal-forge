import { expect, test } from "bun:test";
import { recordOperatorAction } from "../src/journal.js";
import { queryShape, usageReport } from "../src/reports/usage.js";
import { openDatabase } from "../src/storage/database.js";
import { aCall } from "./fixtures/build.js";

test("two askings of one question have one shape, and different questions do not", () => {
  const shape = queryShape("SELECT * FROM events WHERE source='openrouter' AND id > 100");
  expect(queryShape("SELECT  *\n  FROM events WHERE source='arena'   AND id > 4200")).toBe(shape);
  // The projection used to make it a different question, and that was wrong: a command is written
  // about a table, and nobody writes two commands because one of them also returns a column.
  expect(queryShape("SELECT source FROM events WHERE source='arena' AND id > 1")).toBe(shape);
  // Counting is a different question from listing, and that distinction is kept.
  expect(queryShape("SELECT COUNT(*) FROM events WHERE source='arena'")).not.toBe(shape);
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
  expect(report.askedByHand[0]?.shape).toBe("deliveries (aggregated)");
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

test("the same question with a different column list is one shape", () => {
  // The measured failure: ten of twenty-two `sql` calls on 2026-09-25 asked about `code_metrics`
  // and the shapes collapsed two of them, because the projections differed.
  const asked = [
    "SELECT name, calls FROM code_metrics WHERE bucket_start >= '2026-09-01' ORDER BY calls DESC",
    "SELECT name, calls, max_duration_ms FROM code_metrics WHERE bucket_start >= '2026-09-02'",
    "SELECT COUNT(*) FROM code_metrics WHERE name = 'x'",
  ].map(queryShape);
  expect(new Set(asked).size).toBe(2);
  expect(asked[0]).toBe("code_metrics");
  expect(asked[2]).toBe("code_metrics (aggregated)");

  // A join is the pair of tables, in a fixed order whichever way it was written.
  expect(queryShape("SELECT * FROM events e JOIN story_events se ON se.event_id = e.id")).toBe(
    queryShape("SELECT e.id FROM story_events se JOIN events e ON e.id = se.event_id LIMIT 5"),
  );
  // And a question about a different table is still a different question.
  expect(queryShape("SELECT * FROM sources")).not.toBe(queryShape("SELECT * FROM events"));
});

test("a question an existing command already answers is named as such", () => {
  const db = openDatabase(":memory:");
  // Twice, because once is a one-off. This is the case that has actually happened here: a command
  // existed, was listed to every agent, and the question was asked by hand anyway.
  for (let index = 0; index < 2; index++)
    aCall(db, { operation: "sql", input: { query: `SELECT name, calls FROM code_metrics LIMIT ${index}` } });
  aCall(db, { operation: "sql", input: { query: "SELECT 1 FROM a_table_no_command_reads" } });
  aCall(db, { operation: "sql", input: { query: "SELECT 2 FROM a_table_no_command_reads" } });

  const report = usageReport(db, 30, Date.parse("2026-09-25T12:00:00.000Z"));
  const covered = report.askedByHand.find((shape) => shape.shape === "code_metrics");
  expect(covered?.asked).toBe(2);
  expect(covered?.coveredBy).toBe("timings");
  const uncovered = report.askedByHand.find((shape) => shape.shape === "a_table_no_command_reads");
  expect(uncovered?.coveredBy).toBeNull();
  db.close();
});
