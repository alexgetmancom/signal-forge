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
