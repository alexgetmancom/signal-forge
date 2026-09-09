import { expect, test } from "bun:test";
import { type Destination, loadConfig } from "../src/config.js";
import { type Collection, saveCollection } from "../src/events.js";
import { listLifecycleDeadlines, rebuildLifecycleDeadlines, scheduleLifecycleReminders } from "../src/lifecycle.js";
import { parseOpenAIDeprecations } from "../src/sources/deprecations.js";
import { openDatabase } from "../src/storage/database.js";

const baseConfig = loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname });
const destination: Destination = { id: "dc", platform: "discord", channelId: "123", streams: ["deprecations"] };
const now = Date.parse("2026-09-10T00:00:00.000Z");

function lifecycleRecord(retirement: string, fields: Record<string, unknown> = {}): Collection["records"][number] {
  return {
    id: "claude-example",
    name: "Claude example model",
    url: "https://platform.claude.com/docs/en/about-claude/model-deprecations",
    maker: "Anthropic",
    stage: "Deprecated",
    deprecated: null,
    retirement,
    ...fields,
  };
}

function collection(records: Collection["records"], appendOnly = true): Collection {
  return {
    source: "anthropic-deprecations",
    stream: "deprecations",
    url: "https://platform.claude.com/docs/en/about-claude/model-deprecations",
    raw: records,
    appendOnly,
    trackChanges: true,
    records,
  };
}

function createDeadline(db: ReturnType<typeof openDatabase>, record = lifecycleRecord("2026-10-14")): void {
  saveCollection(db, collection([]), [], "2026-09-09T00:00:00.000Z");
  saveCollection(db, collection([record]), [], "2026-09-10T00:01:00.000Z");
}

function configWithDestination() {
  return { ...baseConfig, destinations: [destination] };
}

test("Anthropic retirement creates a deadline and 30, 7 and 1 day reminders", () => {
  const db = openDatabase(":memory:");
  createDeadline(db);
  const deadline = listLifecycleDeadlines(db, 365, now)[0];
  expect(deadline).toMatchObject({
    title: "Claude example model",
    deadlineType: "retirement",
    deadlineAt: "2026-10-14T00:00:00.000Z",
    source: "anthropic-deprecations",
    active: true,
  });
  expect(deadline?.reminders).toEqual([
    { offsetDays: 30, dueAt: "2026-09-14T00:00:00.000Z", batchId: null },
    { offsetDays: 7, dueAt: "2026-10-07T00:00:00.000Z", batchId: null },
    { offsetDays: 1, dueAt: "2026-10-13T00:00:00.000Z", batchId: null },
  ]);
  db.close();
});

test("a due reminder creates one lifecycle batch linked to the original evidence", () => {
  const db = openDatabase(":memory:");
  createDeadline(db);
  const eventId = Number(db.query<{ id: number }, []>("SELECT id FROM events").get()?.id ?? 0);
  const sent = scheduleLifecycleReminders(db, configWithDestination(), Date.parse("2026-09-14T00:00:00.000Z"));
  expect(sent).toBe(1);
  expect(db.query("SELECT kind,context_json FROM batches").get()).toMatchObject({ kind: "lifecycle_reminder" });
  expect(db.query("SELECT event_id FROM batch_events").get()).toEqual({ event_id: eventId });
  expect(db.query("SELECT COUNT(*) AS count FROM deliveries").get()).toEqual({ count: 1 });
  const body = db.query<{ body: string }, []>("SELECT body FROM deliveries").get()?.body ?? "";
  expect(body).toContain("LIFECYCLE DEADLINE");
  expect(body).toContain("Claude example model retires in 30 days");
  expect(body).toContain("Evidence");
  db.close();
});

test("a shadow deprecation source creates no reminder batch or delivery", () => {
  const db = openDatabase(":memory:");
  createDeadline(db);
  const config = { ...configWithDestination(), sourceMode: { "anthropic-deprecations": "shadow" as const } };
  expect(scheduleLifecycleReminders(db, config, Date.parse("2026-09-14T00:00:00.000Z"))).toBe(0);
  expect(db.query("SELECT COUNT(*) AS count FROM batches").get()).toEqual({ count: 0 });
  expect(db.query("SELECT COUNT(*) AS count FROM deliveries").get()).toEqual({ count: 0 });
  expect(db.query("SELECT batch_id FROM lifecycle_reminders WHERE offset_days=30").get()).toEqual({ batch_id: null });
  db.close();
});

test("rebuilds preserve sent reminder identity and update only future unsent dates", () => {
  const db = openDatabase(":memory:");
  createDeadline(db);
  scheduleLifecycleReminders(db, configWithDestination(), Date.parse("2026-09-14T00:00:00.000Z"));
  const before = db
    .query<{ offset_days: number; due_at: string; batch_id: number | null }, []>(
      "SELECT offset_days,due_at,batch_id FROM lifecycle_reminders ORDER BY offset_days DESC",
    )
    .all();
  const changed = lifecycleRecord("2026-10-21");
  saveCollection(db, collection([changed]), [], "2026-09-15T00:00:00.000Z");
  rebuildLifecycleDeadlines(db, Date.parse("2026-09-15T00:00:00.000Z"));
  const after = db
    .query<{ offset_days: number; due_at: string; batch_id: number | null }, []>(
      "SELECT offset_days,due_at,batch_id FROM lifecycle_reminders ORDER BY offset_days DESC",
    )
    .all();
  expect(after[0]).toEqual(before[0]);
  expect(after.slice(1)).toEqual([
    { offset_days: 7, due_at: "2026-10-14T00:00:00.000Z", batch_id: null },
    { offset_days: 1, due_at: "2026-10-20T00:00:00.000Z", batch_id: null },
  ]);
  db.close();
});

test("running the scheduler again or after an ambiguous delivery never creates another reminder batch", () => {
  const db = openDatabase(":memory:");
  createDeadline(db);
  const config = configWithDestination();
  const due = Date.parse("2026-09-14T00:00:00.000Z");
  expect(scheduleLifecycleReminders(db, config, due)).toBe(1);
  expect(scheduleLifecycleReminders(db, config, due)).toBe(0);
  db.query("UPDATE deliveries SET status='ambiguous'").run();
  expect(scheduleLifecycleReminders(db, config, due)).toBe(0);
  expect(db.query("SELECT COUNT(*) AS count FROM batches").get()).toEqual({ count: 1 });
  expect(db.query("SELECT batch_id FROM lifecycle_reminders WHERE offset_days=30").get()).toMatchObject({
    batch_id: 1,
  });
  db.close();
});

test("retraction and removal deactivate lifecycle deadlines without synthetic events", () => {
  const retracted = openDatabase(":memory:");
  createDeadline(retracted);
  const before = retracted.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count;
  saveCollection(
    retracted,
    collection([lifecycleRecord("2026-10-14", { stage: "Retracted", retracted: true })]),
    [],
    "2026-09-11T00:00:00.000Z",
  );
  expect(retracted.query("SELECT active FROM lifecycle_deadlines").get()).toEqual({ active: 0 });
  expect(retracted.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count).toBe(
    (before ?? 0) + 1,
  );
  retracted.close();

  const removed = openDatabase(":memory:");
  const keep = { id: "keep", name: "Keep" };
  saveCollection(removed, { ...collection([keep], false), raw: [keep] }, [], "2026-09-09T00:00:00.000Z");
  saveCollection(
    removed,
    { ...collection([keep, lifecycleRecord("2026-10-14")], false), raw: [keep, lifecycleRecord("2026-10-14")] },
    [],
    "2026-09-10T00:00:00.000Z",
  );
  saveCollection(removed, { ...collection([keep], false), raw: [keep] }, [], "2026-09-11T00:00:00.000Z");
  saveCollection(removed, { ...collection([keep], false), raw: [keep] }, [], "2026-09-12T00:00:00.000Z");
  expect(removed.query("SELECT active FROM lifecycle_deadlines").get()).toEqual({ active: 0 });
  removed.close();
});

test("ambiguous OpenAI deprecation prose does not create a deadline", () => {
  const markdown = [
    "### 2026-09-10: Example models",
    "",
    "The notice was published on 2026-09-10; removal is planned for 2027-01-01 and review is planned for 2027-02-01.",
  ].join("\n");
  const parsed = parseOpenAIDeprecations(markdown);
  const db = openDatabase(":memory:");
  const empty: Collection = { ...parsed, records: [], raw: [] };
  saveCollection(db, empty, [], "2026-09-10T00:00:00.000Z");
  saveCollection(db, parsed, [], "2026-09-10T00:01:00.000Z");
  expect(db.query("SELECT COUNT(*) AS count FROM lifecycle_deadlines").get()).toEqual({ count: 0 });
  db.close();
});
