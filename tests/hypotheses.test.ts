import { expect, test } from "bun:test";
import { type Collection, saveCollection } from "../src/events.js";
import { getHypothesis, listHypotheses, rebuildHypotheses } from "../src/hypotheses.js";
import { openDatabase } from "../src/storage/database.js";

function introduce(
  db: ReturnType<typeof openDatabase>,
  source: string,
  stream: Collection["stream"],
  record: Collection["records"][number],
  at: string,
): number {
  const collection = (records: Collection["records"]): Collection => ({
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
  introduce(oneSource, "arena", "arena", arenaRecord, "2026-09-10T00:00:00Z");
  expect(listHypotheses(oneSource)).toEqual([]);
  oneSource.close();

  const sameFamily = openDatabase(":memory:");
  introduce(sameFamily, "discovery:github-ai", "github", githubRecord, "2026-09-10T00:00:00Z");
  introduce(sameFamily, "discovery:github-llm", "github", githubRecord, "2026-09-10T01:00:00Z");
  expect(listHypotheses(sameFamily)).toEqual([]);
  sameFamily.close();
});

test("two independent weak families form an emerging hypothesis and a third strengthens it", () => {
  const db = openDatabase(":memory:");
  const firstEvent = introduce(db, "arena", "arena", arenaRecord, "2026-09-10T00:00:00Z");
  const secondEvent = introduce(db, "discovery:github-ai", "github", githubRecord, "2026-09-10T01:00:00Z");
  let hypothesis = listHypotheses(db)[0];
  expect(hypothesis).toMatchObject({
    status: "emerging",
    independentSourceCount: 2,
    formedAt: "2026-09-10T01:01:00.000Z",
  });
  expect(hypothesis?.events.map((event) => event.eventId)).toEqual([firstEvent, secondEvent]);

  const thirdEvent = introduce(db, "openrouter", "openrouter", thirdRecord, "2026-09-10T02:00:00Z");
  hypothesis = listHypotheses(db)[0];
  expect(hypothesis).toMatchObject({ status: "strengthening", independentSourceCount: 3 });
  expect(hypothesis?.events.map((event) => event.eventId)).toEqual([firstEvent, secondEvent, thirdEvent]);
  db.close();
});

test("a confirmed event resolves a hypothesis and is linked as resolution evidence", () => {
  const db = openDatabase(":memory:");
  introduce(db, "arena", "arena", arenaRecord, "2026-09-10T00:00:00Z");
  introduce(db, "discovery:github-ai", "github", githubRecord, "2026-09-10T01:00:00Z");
  const confirmedEvent = introduce(
    db,
    "openai",
    "api-models",
    { id: "secret-codename", name: "Secret Model", owner: "OpenAI" },
    "2026-09-10T02:00:00Z",
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
    "2026-09-10T00:00:00Z",
  );
  introduce(db, "arena", "arena", arenaRecord, "2026-09-10T01:00:00Z");
  introduce(db, "discovery:github-ai", "github", githubRecord, "2026-09-10T02:00:00Z");
  expect(listHypotheses(db)).toEqual([]);
  db.close();
});

test("unresolved hypotheses become stale after fourteen days and preserve IDs on rebuild", () => {
  const db = openDatabase(":memory:");
  introduce(db, "arena", "arena", arenaRecord, "2026-09-01T00:00:00Z");
  introduce(db, "discovery:github-ai", "github", githubRecord, "2026-09-01T01:00:00Z");
  rebuildHypotheses(db, Date.parse("2026-09-20T00:00:00Z"));
  const before = listHypotheses(db)[0];
  if (!before) throw new Error("Expected a stale hypothesis");
  expect(before?.status).toBe("stale");
  const count = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count;
  rebuildHypotheses(db, Date.parse("2026-09-20T00:00:00Z"));
  const after = getHypothesis(db, before.id);
  expect(after?.id).toBe(before.id);
  expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count).toBe(count);
  expect(after).toEqual(before);
  db.close();
});
