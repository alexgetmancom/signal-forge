import { expect, test } from "bun:test";
import { reactionStandings } from "../src/reports/reactions.js";
import { openDatabase } from "../src/storage/database.js";

function channel(): ReturnType<typeof openDatabase> {
  const db = openDatabase(":memory:");
  db.exec("INSERT INTO snapshots(id,source,collected_at) VALUES(1,'x','2026-09-01T00:00:00.000Z')");
  let next = 0;
  const card = (source: string, signal: string, favour: number, against: number) => {
    next += 1;
    const at = "2026-09-20T00:00:00.000Z";
    db.query(
      `INSERT INTO events(id,source,stream,entity_id,kind,after_json,detected_at,snapshot_id,confidence,evidence_type,authority,signal)
       VALUES(?,?,'news',?,'new','{}',?,1,'observed','status_page','first_party',?)`,
    ).run(next, source, `post-${next}`, at, signal);
    db.query("INSERT INTO batches(id,source,digest,ready_at,kind) VALUES(?,?,0,?,'event')").run(next, source, at);
    db.query(
      `INSERT INTO deliveries(id,batch_id,destination_id,destination_json,body,part,status,updated_at)
       VALUES(?,?,'discord-signals','{}','x',0,'sent',?)`,
    ).run(next, next, at);
    db.query("INSERT INTO delivery_events(delivery_id,event_id) VALUES(?,?)").run(next, next);
    db.query("INSERT INTO scout_reactions(delivery_id,votes,against,read_at) VALUES(?,?,?,?)").run(
      next,
      favour,
      against,
      at,
    );
  };
  card("gemini-models-blog", "article", 0, 3);
  card("anthropic", "launch", 2, 0);
  card("openai", "launch", 1, 0);
  return db;
}

const now = Date.parse("2026-09-24T00:00:00.000Z");

test("the thumbs are reported by source and by kind, and say plainly that there are too few to calibrate on", () => {
  const report = reactionStandings(channel(), 60, now);
  expect(report.sources[0]).toMatchObject({ key: "gemini-models-blog", cards: 1, favour: 0, against: 3 });
  // The kind of card is the cut that matters later: a blog post and a launch are not one taste.
  expect(report.signals.find((row) => row.key === "launch")).toMatchObject({ cards: 2, favour: 3, against: 0 });
  expect(report.signals.find((row) => row.key === "article")).toMatchObject({ against: 3 });
  // Three votes against is a mood. The bar was named before the data was looked at.
  expect(report.against).toBe(3);
  expect(report.enoughToCalibrate).toBe(false);
});
