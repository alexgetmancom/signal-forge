import { expect, test } from "bun:test";
import { readersVote } from "../src/insights.js";
import { openDatabase } from "../src/storage/database.js";

/**
 * The channel's thumbs, as the tables actually record them: a card is a delivery, a delivery carries
 * events, and `scout_reactions` holds the counts the Discord reader last saw.
 */
function channel(): ReturnType<typeof openDatabase> {
  const db = openDatabase(":memory:");
  db.exec("INSERT INTO snapshots(id,source,collected_at) VALUES(1,'x','2026-09-01T00:00:00.000Z')");
  let next = 0;
  const card = (source: string, favour: number, against: number, detectedAt = "2026-09-20T00:00:00.000Z") => {
    next += 1;
    db.query(
      `INSERT INTO events(id,source,stream,entity_id,kind,after_json,detected_at,snapshot_id,confidence,evidence_type,authority)
       VALUES(?,?,'news',?,'new','{}',?,1,'observed','status_page','first_party')`,
    ).run(next, source, `post-${next}`, detectedAt);
    db.query("INSERT INTO batches(id,source,digest,ready_at,kind) VALUES(?,?,0,?,'event')").run(
      next,
      source,
      detectedAt,
    );
    db.query(
      `INSERT INTO deliveries(id,batch_id,destination_id,destination_json,body,part,status,updated_at)
       VALUES(?,?,'discord-signals','{}','x',0,'sent',?)`,
    ).run(next, next, detectedAt);
    db.query("INSERT INTO delivery_events(delivery_id,event_id) VALUES(?,?)").run(next, next);
    db.query("INSERT INTO scout_reactions(delivery_id,votes,against,read_at) VALUES(?,?,?,?)").run(
      next,
      favour,
      against,
      detectedAt,
    );
  };
  card("gemini-models-blog", 0, 3);
  card("anthropic", 2, 0);
  card("xai", 1, 1);
  card("codex-resets", 2, 1);
  card("stale-blog", 0, 4, "2026-05-01T00:00:00.000Z");
  return db;
}

const now = new Date("2026-09-24T00:00:00.000Z");

test("a source the channel voted against speaks with a weaker voice, and one it argued over keeps its own", () => {
  const db = channel();
  expect(readersVote(db, "gemini-models-blog", now)).toBe("against");
  // One thumb is a mood, not a verdict: an even split is not a vote against.
  expect(readersVote(db, "xai", now)).toBeNull();
  // Dislikes that lose to likes are an argument the source won.
  expect(readersVote(db, "codex-resets", now)).toBeNull();
  expect(readersVote(db, "anthropic", now)).toBeNull();
  // A source nobody has reacted to has not been voted on, which is not the same as being voted down.
  expect(readersVote(db, "never-seen", now)).toBeNull();
  // Votes expire: what the channel disliked in May is not what it is telling us today.
  expect(readersVote(db, "stale-blog", now)).toBeNull();
});
