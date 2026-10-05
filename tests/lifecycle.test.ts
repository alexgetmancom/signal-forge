import { expect, test } from "bun:test";
import { type Destination, loadConfig } from "../src/config.js";
import { saveCollection } from "../src/events/pipeline.js";
import type { Collection } from "../src/events/types.js";
import { listLifecycleDeadlines, rebuildLifecycleDeadlines, scheduleLifecycleReminders } from "../src/lifecycle.js";
import { logTo } from "../src/logger.js";
import { parseOpenAIDeprecations } from "../src/sources/deprecations.js";
import { parseGeminiDeprecations, parseGroqDeprecations } from "../src/sources/lifecycle.js";
import { openDatabase } from "../src/storage/database.js";

const baseConfig = loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname });
const destination: Destination = {
  id: "dc",
  platform: "discord",
  channelId: "123",
  signals: ["launch", "codename", "evidence", "change", "reminder"],
};
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

test("structured retirement dates create deadlines for non-Anthropic lifecycle sources", () => {
  const db = openDatabase(":memory:");
  const html = `<table><tr><th>Model</th><th>Release date</th><th>Shutdown date</th><th>Recommended replacement</th></tr>
    <tr><td>gemini-2.0-flash</td><td>February 5, 2025</td><td>October 1, 2026</td><td>gemini-3.5-flash</td></tr></table>`;
  const parsed = parseGeminiDeprecations(html);
  // `appendOnly` is the registry's, spread on by the poller; these two calls stand in for it.
  const polled: Collection = { ...parsed, appendOnly: true };
  saveCollection(db, { ...polled, records: [], raw: "baseline" }, [], "2026-09-09T00:00:00.000Z");
  saveCollection(db, polled, [], "2026-09-10T00:01:00.000Z");
  expect(listLifecycleDeadlines(db, 365, now)[0]).toMatchObject({
    title: "gemini-2.0-flash",
    source: "gemini-deprecations",
    deadlineType: "retirement",
    deadlineAt: "2026-10-01T00:00:00.000Z",
    replacement: "gemini-3.5-flash",
  });
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
  expect(body).toContain("platform.claude.com/docs/en/about-claude/model-deprecations");
  // The reminder names the deadline it is about, so every report that counts what a source
  // delivered can see this one. Without the link the deprecation reads as never having reached
  // anybody, and the source that found it reads as a source worth switching off.
  expect(
    db
      .query<{ event_id: number }, []>(
        "SELECT de.event_id FROM delivery_events de JOIN deliveries d ON d.id=de.delivery_id",
      )
      .all(),
  ).toEqual([{ event_id: eventId }]);
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
  const polled: Collection = { ...parsed, appendOnly: true };
  const empty: Collection = { ...polled, records: [], raw: [] };
  saveCollection(db, empty, [], "2026-09-10T00:00:00.000Z");
  saveCollection(db, polled, [], "2026-09-10T00:01:00.000Z");
  expect(db.query("SELECT COUNT(*) AS count FROM lifecycle_deadlines").get()).toEqual({ count: 0 });
  db.close();
});

test("rows of a lifecycle page that share an id stand as one, the last, and the folding is counted and said once", () => {
  // The same model listed twice -- under two headings, with two dates -- was one record by an
  // expression nobody could see being applied, and the earlier row's dates were dropped with no
  // trace of it. What stands is unchanged; that it happened is now a line in the log.
  const table = (rows: string[][]) =>
    `<table><tr><th>Deprecated Model</th><th>Shutdown Date</th><th>Recommended Replacement Model ID</th></tr>${rows
      .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
      .join("")}</table>`;
  const lines: string[] = [];
  logTo((line) => {
    lines.push(line);
  });
  try {
    const twice = parseGroqDeprecations(
      table([
        ["old-model", "08/16/26", "new-model"],
        ["other-model", "08/16/26", "newer-model"],
        ["old-model", "09/30/26", "newest-model"],
      ]),
    );
    expect(twice.records.map((record) => `${record.modelId} ${record.replacement}`)).toEqual([
      "old-model newest-model",
      "other-model newer-model",
    ]);
    // The same page again says nothing new, and a page with nothing folded says nothing at all.
    parseGroqDeprecations(
      table([
        ["old-model", "08/16/26", "new-model"],
        ["other-model", "08/16/26", "newer-model"],
        ["old-model", "09/30/26", "newest-model"],
      ]),
    );
    const folded = lines.filter((line) => line.includes("Lifecycle rows that share an id"));
    expect(folded).toHaveLength(1);
    expect(folded[0]).toContain('"merged":1');
    expect(folded[0]).toContain('"rows":3');
    expect(folded[0]).toContain("groq");
    lines.length = 0;
    parseGroqDeprecations(table([["old-model", "08/16/26", "new-model"]]));
    expect(lines.filter((line) => line.includes("Lifecycle rows that share an id"))).toEqual([]);
  } finally {
    logTo(null);
  }
});

/**
 * A router's expiry date is a deadline that accumulates and tells nobody.
 *
 * On 2026-10-04 OpenRouter carried thirty-three of these -- Qwen's block five days out, Gemini 2.5
 * Pro sixteen -- against thirty-four deadlines known from every deprecation page this service reads
 * together, and the two sets did not overlap anywhere. They are worth holding for that reason
 * alone. They do not remind, because `google/gemini-2.5-pro` leaving one router is not Gemini 2.5
 * Pro dying, and the reminder card has one sentence for both.
 */
test("a router's expiry date is a deadline with no reminders", () => {
  const db = openDatabase(":memory:");
  const listing = (fields: Record<string, unknown> = {}) => ({
    id: "google/gemini-2.5-pro",
    name: "Google: Gemini 2.5 Pro",
    url: "https://openrouter.ai/google/gemini-2.5-pro",
    context: 1_048_576,
    ...fields,
  });
  const router = (records: Collection["records"]): Collection => ({
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai/models",
    raw: records,
    records,
  });
  saveCollection(db, router([listing()]), [], "2026-09-09T00:00:00.000Z");
  saveCollection(db, router([listing({ expirationDate: "2026-10-20" })]), [], "2026-09-10T00:01:00.000Z");
  rebuildLifecycleDeadlines(db, now);
  const deadline = listLifecycleDeadlines(db, 365, now)[0];
  expect(deadline).toMatchObject({
    title: "Google: Gemini 2.5 Pro",
    source: "openrouter",
    deadlineType: "shutdown",
    deadlineAt: "2026-10-20T00:00:00.000Z",
    active: true,
  });
  // Known, and nobody told: the reminder rows are what a card is built from, so an empty list is
  // the whole of the promise this test makes.
  expect(deadline?.reminders).toEqual([]);
  db.close();
});
