import { expect, test } from "bun:test";
import { tableReferences } from "../src/reports/references.js";
import { openDatabase } from "../src/storage/database.js";
import { anEvent } from "./fixtures/build.js";

test("what refuses a delete is read out of the schema, not written down", () => {
  const db = openDatabase(":memory:");
  const report = tableReferences(db, "events");

  // Thirteen keys point at events. Six take care of themselves and two forget their parent; the
  // ones under `refuses` are the whole of the work, and this is the list a retention has to clear.
  expect(report.cascades.length + report.clears.length + report.refuses.length).toBe(report.referencedBy.length);
  expect(report.refuses).toContain("suppressions.event_id");
  expect(report.cascades).toContain("story_events.event_id");
  expect(report.clears).toContain("model_fact_fields.event_id");
  // The table itself is last: everything that refuses it comes first.
  expect(report.deletionOrder.at(-1)).toBe("events");
  for (const refusing of report.refuses) expect(report.deletionOrder).toContain(refusing.split(".")[0] as string);
});

test("a delete that is refused stays refused", () => {
  const db = openDatabase(":memory:");
  const event = anEvent(db);
  db.query(
    "INSERT INTO suppressions(event_id,destination_id,batch_id,reason,detail,recorded_at) VALUES(?,?,?,?,?,?)",
  ).run(event, "discord-signals", 1, "test", "", "2026-09-25T12:00:00.000Z");
  expect(() => db.query("DELETE FROM events WHERE id=?").run(event)).toThrow();
  expect(tableReferences(db, "events").refuses).toContain("suppressions.event_id");
});

test("a child whose parent is gone is counted rather than assumed away", () => {
  const db = openDatabase(":memory:");
  const event = anEvent(db);
  // Foreign keys were not always enforced, so this is a state the stored data can genuinely be in.
  db.exec("PRAGMA foreign_keys=OFF");
  db.query("INSERT INTO story_events(story_id,event_id) VALUES(?,?)").run(1, event + 999);
  const orphaned = tableReferences(db, "events").referencedBy.find((child) => child.table === "story_events");
  expect(orphaned?.orphans).toBe(1);
  expect(tableReferences(db, "events").referencedBy[0]?.table).toBe("story_events");
});
