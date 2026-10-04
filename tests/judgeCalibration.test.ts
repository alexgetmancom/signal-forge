import { expect, test } from "bun:test";
import { PROMPT_VERSION } from "../src/jev.js";
import { judgeCalibration } from "../src/reports/judgeCalibration.js";
import { openDatabase } from "../src/storage/database.js";
import { aBatch, aDelivery, anEvent } from "./fixtures/build.js";

const at = "2026-10-01T00:00:00.000Z";
const now = Date.parse("2026-10-04T00:00:00.000Z");

/** One card, the scores of the events in it, and the thumbs a reader left on it. */
function card(
  db: ReturnType<typeof openDatabase>,
  worths: number[],
  thumbs: { votes: number; against: number } | "read" | "unread",
): void {
  const deliveryId = aDelivery(db, { batchId: aBatch(db, { readyAt: at }), updatedAt: at });
  for (const worth of worths) {
    const eventId = anEvent(db, { detectedAt: at });
    db.query("INSERT INTO delivery_events(delivery_id,event_id) VALUES(?,?)").run(deliveryId, eventId);
    db.query(
      `INSERT INTO event_evaluations(event_id,evaluator,model,prompt_version,kind,worth,codename,confidence,rules,evaluated_at)
       VALUES(?,'jev','jev-latest',?,'feature',?,0,null,'evidence',?)`,
    ).run(eventId, PROMPT_VERSION, worth, at);
  }
  if (thumbs === "unread") return;
  const left = thumbs === "read" ? { votes: 0, against: 0 } : thumbs;
  db.query("INSERT INTO scout_reactions(delivery_id,votes,against,read_at) VALUES(?,?,?,?)").run(
    deliveryId,
    left.votes,
    left.against,
    at,
  );
}

test("a card is banded by the best score it carries, and a card that was read without a thumb is not a vote", () => {
  const db = openDatabase(":memory:");
  // A digest is as good as the thing it leads with: the mean of these is 0.8 and the band is 2-3.
  card(db, [0.2, 0.4, 2.4], { votes: 3, against: 1 });
  card(db, [0.5], { votes: 1, against: 0 });
  // Read and not voted on. `scout_reactions` has a row for it, and it is the silence, not a 0-0 vote.
  card(db, [0.6], "read");
  // Delivered, never opened.
  card(db, [0.7], "unread");
  // No judgement at this prompt version at all, which is most of what goes out.
  const orphan = aDelivery(db, { batchId: aBatch(db, { readyAt: at }), updatedAt: at });
  db.query("INSERT INTO delivery_events(delivery_id,event_id) VALUES(?,?)").run(
    orphan,
    anEvent(db, { detectedAt: at }),
  );

  const report = judgeCalibration(db, 60, now);
  expect(report.unjudgedCards).toBe(1);
  const band = (from: number) => report.bands.find((row) => row.from === from);
  expect(band(0)).toMatchObject({ delivered: 3, voted: 1, favour: 1, against: 0, favourRate: 1 });
  expect(band(2)).toMatchObject({ delivered: 1, voted: 1, favour: 3, against: 1, favourRate: 0.75 });
  expect(band(1)?.delivered).toBe(0);
});
