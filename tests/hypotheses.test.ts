import { expect, test } from "bun:test";
import { saveCollection } from "../src/events/pipeline.js";
import type { Collection } from "../src/events/types.js";
import { getHypothesis, listHypotheses, rebuildHypotheses, updateHypotheses } from "../src/hypotheses.js";
import { openDatabase } from "../src/storage/database.js";
import { registered } from "./registered.js";

function introduce(
  db: ReturnType<typeof openDatabase>,
  source: string,
  stream: Collection["stream"],
  record: Collection["records"][number],
  at: string,
): number {
  const collection = (records: Collection["records"]): Collection =>
    registered({
      source,
      stream,
      url: `https://example.test/${source}`,
      raw: records,
      appendOnly: true,
      records,
    });
  saveCollection(db, collection([]), [], at);
  saveCollection(db, collection([record]), [], new Date(Date.parse(at) + 60_000).toISOString());
  return Number(db.query<{ id: number }, []>("SELECT MAX(id) AS id FROM events").get()?.id ?? 0);
}

const arenaRecord = { id: "secret-codename", name: "Secret Model", model: "secret-codename", maker: "OpenAI" };
const githubRecord = { id: "openai/secret-codename", name: "openai/secret-codename", owner: "openai" };
const thirdRecord = { id: "secret-codename", name: "Secret Model", maker: "OpenAI" };

test("one weak source or repeated source family does not create a hypothesis", () => {
  const oneSource = openDatabase(":memory:");
  introduce(oneSource, "arena", "arena", arenaRecord, "2026-09-10T00:00:00.000Z");
  expect(listHypotheses(oneSource)).toEqual([]);
  oneSource.close();

  const sameFamily = openDatabase(":memory:");
  introduce(sameFamily, "discovery:github-ai", "github", githubRecord, "2026-09-10T00:00:00.000Z");
  introduce(sameFamily, "discovery:github-llm", "github", githubRecord, "2026-09-10T01:00:00.000Z");
  expect(listHypotheses(sameFamily)).toEqual([]);
  sameFamily.close();
});

test("two independent weak families form an emerging hypothesis and a third strengthens it", () => {
  const db = openDatabase(":memory:");
  const firstEvent = introduce(db, "arena", "arena", arenaRecord, "2026-09-10T00:00:00.000Z");
  const secondEvent = introduce(db, "discovery:github-ai", "github", githubRecord, "2026-09-10T01:00:00.000Z");
  let hypothesis = listHypotheses(db)[0];
  expect(hypothesis).toMatchObject({
    status: "emerging",
    independentSourceCount: 2,
    formedAt: "2026-09-10T01:01:00.000Z",
  });
  expect(hypothesis?.events.map((event) => event.eventId)).toEqual([firstEvent, secondEvent]);

  const thirdEvent = introduce(db, "openrouter", "openrouter", thirdRecord, "2026-09-10T02:00:00.000Z");
  hypothesis = listHypotheses(db)[0];
  expect(hypothesis).toMatchObject({ status: "strengthening", independentSourceCount: 3 });
  expect(hypothesis?.events.map((event) => event.eventId)).toEqual([firstEvent, secondEvent, thirdEvent]);
  db.close();
});

test("a confirmed event resolves a hypothesis and is linked as resolution evidence", () => {
  const db = openDatabase(":memory:");
  introduce(db, "arena", "arena", arenaRecord, "2026-09-10T00:00:00.000Z");
  introduce(db, "discovery:github-ai", "github", githubRecord, "2026-09-10T01:00:00.000Z");
  const confirmedEvent = introduce(
    db,
    "openai",
    "api-models",
    { id: "secret-codename", name: "Secret Model", owner: "OpenAI" },
    "2026-09-10T02:00:00.000Z",
  );
  const hypothesis = listHypotheses(db)[0];
  expect(hypothesis).toMatchObject({ status: "confirmed", resolutionEventId: confirmedEvent });
  expect(hypothesis?.events.find((event) => event.eventId === confirmedEvent)?.role).toBe("resolution");
  expect(db.query("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 3 });
  expect(db.query("SELECT COUNT(*) AS count FROM batches").get()).toEqual({ count: 0 });
  db.close();
});

test("confirmation before two weak families never creates a hypothesis", () => {
  const db = openDatabase(":memory:");
  introduce(
    db,
    "openai",
    "api-models",
    { id: "secret-codename", name: "Secret Model", owner: "OpenAI" },
    "2026-09-10T00:00:00.000Z",
  );
  introduce(db, "arena", "arena", arenaRecord, "2026-09-10T01:00:00.000Z");
  introduce(db, "discovery:github-ai", "github", githubRecord, "2026-09-10T02:00:00.000Z");
  expect(listHypotheses(db)).toEqual([]);
  db.close();
});

test("unresolved hypotheses become stale after fourteen days and preserve IDs on rebuild", () => {
  const db = openDatabase(":memory:");
  introduce(db, "arena", "arena", arenaRecord, "2026-09-01T00:00:00.000Z");
  introduce(db, "discovery:github-ai", "github", githubRecord, "2026-09-01T01:00:00.000Z");
  rebuildHypotheses(db, Date.parse("2026-09-20T00:00:00.000Z"));
  const before = listHypotheses(db)[0];
  if (!before) throw new Error("Expected a stale hypothesis");
  expect(before?.status).toBe("stale");
  const count = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count;
  rebuildHypotheses(db, Date.parse("2026-09-20T00:00:00.000Z"));
  const after = getHypothesis(db, before.id);
  expect(after?.id).toBe(before.id);
  expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count).toBe(count);
  expect(after).toEqual(before);
  db.close();
});

/** The stored projection as one comparable string, so equivalence is compared rather than asserted. */
function projected(db: ReturnType<typeof openDatabase>): string {
  const rows = db
    .query<Record<string, unknown>, []>(
      `SELECT h.stable_key,h.story_id,h.subject,h.status,h.independent_source_count,h.first_seen_at,h.formed_at,
              h.updated_at,h.resolved_at,h.resolution_event_id,
              (SELECT group_concat(he.role || ':' || he.event_id, ',')
                 FROM (SELECT role,event_id FROM hypothesis_events WHERE hypothesis_id=h.id ORDER BY role,event_id) he
              ) AS events
       FROM hypotheses h ORDER BY h.stable_key`,
    )
    .all();
  return JSON.stringify(rows);
}

test("an incremental update of the stories that moved equals a full rebuild", () => {
  const db = openDatabase(":memory:");
  const storyIds = () =>
    db
      .query<{ id: number }, []>("SELECT id FROM stories ORDER BY id")
      .all()
      .map((row) => row.id);
  introduce(db, "arena", "arena", arenaRecord, "2026-09-10T00:00:00.000Z");
  introduce(db, "discovery:github-ai", "github", githubRecord, "2026-09-10T01:00:00.000Z");
  introduce(db, "models-dev", "api-models", thirdRecord, "2026-09-10T02:00:00.000Z");
  // A second, unrelated subject, so a dirty set that is narrower than "everything" is actually
  // narrower: recomputing one story must leave the other alone and still agree with the whole.
  const other = { id: "other-codename", name: "Other Model", model: "other-codename", maker: "Anthropic" };
  introduce(db, "arena", "arena", other, "2026-09-11T00:00:00.000Z");
  introduce(
    db,
    "discovery:github-ai",
    "github",
    { id: "anthropic/other-codename", name: "anthropic/other-codename" },
    "2026-09-11T01:00:00.000Z",
  );

  const now = Date.parse("2026-09-12T00:00:00.000Z");
  rebuildHypotheses(db, now);
  const full = projected(db);
  expect(JSON.parse(full).length).toBeGreaterThan(0);

  // Story by story, one at a time: nothing changed between the two passes, so nothing may move.
  for (const id of storyIds()) updateHypotheses(db, [id], now);
  expect(projected(db)).toBe(full);

  // And from empty: the same rows have to be reachable through the incremental path alone.
  db.exec("DELETE FROM hypotheses");
  for (const id of storyIds()) updateHypotheses(db, [id], now);
  expect(projected(db)).toBe(full);
  db.close();
});

test("a story crossing the fourteen-day line goes stale without any event to trigger it", () => {
  const db = openDatabase(":memory:");
  introduce(db, "arena", "arena", arenaRecord, "2026-09-01T00:00:00.000Z");
  introduce(db, "discovery:github-ai", "github", githubRecord, "2026-09-01T01:00:00.000Z");
  const fresh = Date.parse("2026-09-02T00:00:00.000Z");
  rebuildHypotheses(db, fresh);
  expect(listHypotheses(db)[0]?.status).toBe("emerging");

  // Nothing arrives. The only thing that changes is the clock, so an empty dirty set is the whole
  // test: `agingStories` has to find the story that the passage of time has moved.
  const later = Date.parse("2026-09-20T00:00:00.000Z");
  updateHypotheses(db, [], later);
  expect(listHypotheses(db)[0]?.status).toBe("stale");
  const incremental = projected(db);
  rebuildHypotheses(db, later);
  expect(projected(db)).toBe(incremental);
  db.close();
});

test("a story that stops supporting a hypothesis loses it through the incremental path", () => {
  const db = openDatabase(":memory:");
  introduce(db, "arena", "arena", arenaRecord, "2026-09-10T00:00:00.000Z");
  introduce(db, "discovery:github-ai", "github", githubRecord, "2026-09-10T01:00:00.000Z");
  const now = Date.parse("2026-09-11T00:00:00.000Z");
  rebuildHypotheses(db, now);
  const story = db.query<{ id: number }, []>("SELECT story_id AS id FROM hypotheses").get();
  expect(story).not.toBeNull();
  // Unlink one family's evidence: the story keeps existing and no longer has two of them.
  db.exec("DELETE FROM story_events WHERE event_id IN (SELECT MIN(event_id) FROM story_events)");
  updateHypotheses(db, [Number(story?.id)], now);
  expect(listHypotheses(db)).toEqual([]);
  db.close();
});
