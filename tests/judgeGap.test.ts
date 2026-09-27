import { expect, test } from "bun:test";
import { PROMPT_VERSION } from "../src/jev.js";
import { judgeGap } from "../src/reports/judgeGap.js";
import { openDatabase } from "../src/storage/database.js";
import { aBatch, aDelivery, anEvent } from "./fixtures/build.js";

const now = new Date("2026-09-27T12:00:00.000Z");
const at = "2026-09-20T09:00:00.000Z";

function aJudgement(
  db: ReturnType<typeof openDatabase>,
  eventId: number,
  worth: number,
  version: string = PROMPT_VERSION,
) {
  db.query(
    `INSERT INTO event_evaluations(event_id,evaluator,model,prompt_version,kind,worth,codename,confidence,rules,evaluated_at)
     VALUES(?,'jev','jev-latest',?,'feature',?,0,null,'evidence',?)`,
  ).run(eventId, version, worth, at);
}

/** An event Jev rated highly that a rule stopped, in the stream and with the reason given. */
function held(db: ReturnType<typeof openDatabase>, stream: string, reason: string, worth = 2.5): number {
  const event = anEvent(db, { stream, source: stream, entityId: `${stream}-${reason}-${worth}`, detectedAt: at });
  aJudgement(db, event, worth);
  db.query(
    `INSERT INTO suppressions(event_id,destination_id,batch_id,reason,detail,recorded_at)
     VALUES(?,'scouts',?,?,'',?)`,
  ).run(event, aBatch(db, { readyAt: at }), reason, at);
  return event;
}

/** An event a reader was sent although Jev thought little of it. */
function spoke(db: ReturnType<typeof openDatabase>, stream: string, worth = 0.1): number {
  const event = anEvent(db, { stream, source: stream, entityId: `${stream}-spoke-${worth}`, detectedAt: at });
  aJudgement(db, event, worth);
  const delivery = aDelivery(db, { batchId: aBatch(db, { readyAt: at }), updatedAt: at });
  db.query("INSERT INTO delivery_events(delivery_id,event_id) VALUES(?,?)").run(delivery, event);
  return event;
}

test("the breakdown counts the whole window, while the lists stop at the limit asked for", () => {
  const db = openDatabase(":memory:");
  for (let i = 0; i < 3; i += 1) held(db, "arena", "already_out_at_the_maker", 2.5 + i / 10);
  held(db, "arena", "left_to_the_daily_recap");
  held(db, "github", "already_out_at_the_maker");
  for (let i = 0; i < 2; i += 1) spoke(db, "github", 0.1 + i / 10);

  const report = judgeGap(db, 14, 1, now);
  // One row of each list is all that was asked for, and both counts are of five and two anyway.
  expect(report.heldBack).toHaveLength(1);
  expect(report.spoke).toHaveLength(1);
  expect(report.streams).toEqual([
    { stream: "arena", judged: 4, heldBack: 4, spoke: 0 },
    { stream: "github", judged: 3, heldBack: 1, spoke: 2 },
  ]);
  expect(report.reasons).toEqual([
    { stream: "arena", reason: "already_out_at_the_maker", heldBack: 3 },
    { stream: "arena", reason: "left_to_the_daily_recap", heldBack: 1 },
    { stream: "github", reason: "already_out_at_the_maker", heldBack: 1 },
  ]);
  db.close();
});

test("a judgement of a superseded prompt version is counted nowhere", () => {
  // A worth is a property of the question that was asked, and the lists have always said so; the
  // counts are read beside them and would be a different population if they did not.
  const db = openDatabase(":memory:");
  const event = anEvent(db, { stream: "arena", detectedAt: at });
  aJudgement(db, event, 2.9, "1");
  db.query(
    `INSERT INTO suppressions(event_id,destination_id,batch_id,reason,detail,recorded_at)
     VALUES(?,'scouts',?,'already_out_at_the_maker','',?)`,
  ).run(event, aBatch(db, { readyAt: at }), at);

  const report = judgeGap(db, 14, 50, now);
  expect(report.heldBack).toEqual([]);
  expect(report.streams).toEqual([]);
  expect(report.reasons).toEqual([]);
  db.close();
});

test("an event held back for two reasons is one held-back event, counted under each rule", () => {
  // `suppressions` has a row per destination, so a two-destination hold used to count twice in a
  // stream's total and disagree with the list beside it.
  const db = openDatabase(":memory:");
  const event = held(db, "news", "left_to_the_daily_recap");
  db.query(
    `INSERT INTO suppressions(event_id,destination_id,batch_id,reason,detail,recorded_at)
     VALUES(?,'wire',?,'already_out_at_the_maker','',?)`,
  ).run(event, aBatch(db, { readyAt: at }), at);

  const report = judgeGap(db, 14, 50, now);
  expect(report.streams).toEqual([{ stream: "news", judged: 1, heldBack: 1, spoke: 0 }]);
  expect(report.reasons.map((row) => row.reason).sort()).toEqual([
    "already_out_at_the_maker",
    "left_to_the_daily_recap",
  ]);
  expect(report.reasons.every((row) => row.heldBack === 1)).toBe(true);
  db.close();
});
