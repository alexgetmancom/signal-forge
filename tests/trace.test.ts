import { expect, test } from "bun:test";
import { trace } from "../src/reports/trace.js";
import { openDatabase } from "../src/storage/database.js";
import { aBatch, aDelivery, anEvent } from "./fixtures/build.js";

/** The pareto case as it arrived: one company's catalogue, its usage board, and a mirror. */
function setup() {
  const db = openDatabase(":memory:");
  db.exec(
    `INSERT INTO stories(id,stable_key,title,normalized_subject,vendor,first_seen_at,updated_at)
     VALUES(1,'unbiased:pareto','unbiased/pareto-26.10-preview-20260929','unbiased pareto 26 10 preview',
            'Unknown','2026-10-01T14:11:59.972Z','2026-10-04T04:20:31.266Z')`,
  );
  const add = (source: string, stream: string, at: string) => {
    const id = anEvent(db, {
      source,
      stream,
      entityId: "unbiased/pareto-26.10-preview-20260929",
      detectedAt: at,
      afterJson: JSON.stringify({ id: "unbiased/pareto-26.10-preview-20260929" }),
    });
    db.query("INSERT INTO story_events(story_id,event_id) VALUES(1,?)").run(id);
    return id;
  };
  return {
    db,
    catalogue: add("openrouter", "openrouter", "2026-10-01T14:11:59.972Z"),
    mirror: add("models-dev", "api-models", "2026-10-01T14:38:27.626Z"),
    board: add("openrouter-usage", "leaderboards", "2026-10-04T04:20:31.266Z"),
  };
}

test("a name off a card finds every sighting of it in order", () => {
  const { db, catalogue, board } = setup();
  const answer = trace(db, "pareto-26.10", 100);
  expect(answer.events.map((event) => event.id)).toEqual([catalogue, expect.any(Number), board]);
  expect(answer.events.map((event) => event.source)).toEqual(["openrouter", "models-dev", "openrouter-usage"]);
  expect(answer.summary.firstSeenAt).toBe("2026-10-01T14:11:59.972Z");
  expect(answer.summary.lastSeenAt).toBe("2026-10-04T04:20:31.266Z");
  expect(answer.stories.map((story) => story.id)).toEqual([1]);
  db.close();
});

test("the sources are counted the way corroboration counts them", () => {
  const { db } = setup();
  // Three source ids, two organisations: the catalogue and the usage board are both OpenRouter.
  // Reading the raw count is what carded this subject on 2026-10-04.
  expect(trace(db, "pareto-26.10", 100).summary.sources).toBe(3);
  expect(trace(db, "pareto-26.10", 100).summary.families).toEqual(["openrouter", "provider-api:models-dev"]);
  db.close();
});

test("a name written with separators still matches the catalogue's spelling", () => {
  const { db } = setup();
  // What a reader has is "Pareto 26.10 preview" off a card; what the catalogue stored is a path.
  expect(trace(db, "Pareto 26.10 preview", 100).summary.events).toBe(3);
  expect(trace(db, "PARETO", 100).summary.events).toBe(3);
  db.close();
});

test("batched, delivered and suppressed are three separate answers", () => {
  const { db, catalogue, board } = setup();
  const batch = aBatch(db, { source: "openrouter" });
  db.query("INSERT INTO batch_events(batch_id,event_id,url,signal) VALUES(?,?,'','codename')").run(batch, catalogue);
  aDelivery(db, { batchId: batch, status: "sent" });
  db.query(
    `INSERT INTO suppressions(event_id,destination_id,batch_id,reason,detail,recorded_at)
     VALUES(?,'discord',?,'no_reader_facing_change','rank only','2026-10-04T04:21:00.000Z')`,
  ).run(board, batch);

  const answer = trace(db, "pareto-26.10", 100);
  const byId = new Map(answer.events.map((event) => [event.id, event]));
  expect(byId.get(catalogue)?.batched).toBe(true);
  expect(byId.get(catalogue)?.delivered).toBe(true);
  expect(byId.get(board)?.batched).toBe(false);
  expect(byId.get(board)?.suppressedBy).toEqual(["no_reader_facing_change"]);
  expect(answer.summary.delivered).toBe(1);
  expect(answer.summary.suppressed).toBe(1);
  db.close();
});

test("a name nothing was ever recorded under answers empty rather than failing", () => {
  const { db } = setup();
  const answer = trace(db, "no-such-model", 100);
  expect(answer.events).toEqual([]);
  expect(answer.summary.firstSeenAt).toBeNull();
  expect(answer.stories).toEqual([]);
  db.close();
});

test("a raw record is held even where no event exists, and says whether anything still asks", () => {
  const db = openDatabase(":memory:");
  db.exec(
    `INSERT INTO sources(id,failures,retired_at) VALUES
       ('openrouter',0,NULL),('a-gateway-we-dropped',0,'2026-09-30T00:00:00.000Z')`,
  );
  const body = JSON.stringify({ id: "holo-4", name: "Holo 4", maker: "Holo", output: ["text"] });
  db.exec(
    `INSERT INTO records(source,id,body,stream,observed_at) VALUES
       ('openrouter','holo-4','${body}','openrouter','2026-10-02T09:00:00.000Z'),
       ('a-gateway-we-dropped','holo-4','${body}','api-models','2026-09-28T09:00:00.000Z')`,
  );
  const answer = trace(db, "holo-4", 100);
  // Nothing was ever an event, and the question "have we seen this" is still answered.
  expect(answer.events).toEqual([]);
  expect(answer.records.map((record) => record.source)).toEqual(["a-gateway-we-dropped", "openrouter"]);
  // The shape of what is held, and not a byte of what it holds.
  expect(answer.records[1]).toMatchObject({
    id: "holo-4",
    stream: "openrouter",
    fields: ["id", "name", "maker", "output"],
    stillRegistered: true,
  });
  expect(answer.records[1]?.bytes).toBe(body.length);
  // And the row from the source the registry dropped says so, which is why it is silent.
  expect(answer.records[0]?.stillRegistered).toBe(false);
  db.close();
});

test("each sighting carries the arrival rule that keeps it out of a week, or nothing", () => {
  const db = openDatabase(":memory:");
  const sighting = (fields: { source: string; stream: string; signal: string; name: string }) =>
    anEvent(db, {
      source: fields.source,
      stream: fields.stream,
      entityId: fields.name,
      signal: fields.signal,
      afterJson: JSON.stringify({ id: fields.name, name: fields.name, maker: "OpenAI" }),
    });
  const board = sighting({ source: "arena-leaderboards", stream: "leaderboards", signal: "rank", name: "gpt-6-holo" });
  const post = sighting({ source: "news:openai", stream: "news", signal: "launch", name: "gpt-6-holo" });
  const listed = sighting({ source: "openrouter", stream: "openrouter", signal: "launch", name: "gpt-6-holo" });
  const video = sighting({ source: "openrouter", stream: "openrouter", signal: "launch", name: "gpt-6-holo-video" });
  const verdicts = new Map(trace(db, "gpt-6-holo", 100).events.map((event) => [event.id, event.notAnArrival]));
  // A placing on a board is neither of the two classes a week's arrivals are drawn from.
  expect(verdicts.get(board)).toBe("neither_a_launch_nor_a_sighting");
  // And a post that earns `launch` is still not a stream that lists models: "Elevated errors
  // affecting ChatGPT Work mode" was counted among a week's fifty-three models this way.
  expect(verdicts.get(post)).toBe("not_a_stream_that_lists_models");
  // A model that returns a clip is a different craft and never a line in this week.
  expect(verdicts.get(video)).toBe("serves_another_modality");
  // And the catalogue row that would count says nothing, which is the absence of a rule.
  expect(verdicts.get(listed)).toBeNull();
  db.close();
});
