import { expect, test } from "bun:test";
import { eventEvidence } from "../src/reports/eventEvidence.js";
import { openDatabase } from "../src/storage/database.js";
import { aBatch, aDelivery, anEvent } from "./fixtures/build.js";

test("an event that passed every rule and still reached nobody says so", () => {
  const db = openDatabase(":memory:");
  // Claude Code dropped `claude-instant-1.1` from its binary on 2026-09-30. No rule vetoed the
  // removal, so `speaks` is 1; no batch was ever built for it, so nobody heard. Read as a column
  // those two look like one fact, and this agent reported the removal to an operator as a card
  // that had gone to the channel.
  const id = anEvent(db, {
    source: "claude-code-models",
    stream: "github",
    entityId: "claude-instant-1.1",
    kind: "removed",
    beforeJson: JSON.stringify({ id: "claude-instant-1.1", maker: "Anthropic" }),
    afterJson: null,
    speaks: true,
  });
  const answer = eventEvidence(db, id);
  if (!answer) throw new Error("no evidence for the event");
  expect(answer.standing.speaks).toBe(true);
  expect(answer.reachedAReader).toBe(false);
  expect(answer.batches).toEqual([]);
  expect(answer.deliveries).toEqual([]);
  db.close();
});

test("a delivery that was accepted is the only thing that means a reader has it", () => {
  const db = openDatabase(":memory:");
  const id = anEvent(db, { entityId: "claude-artifact-preview" });
  const batch = aBatch(db, { source: "claude-code-models" });
  db.query("INSERT INTO batch_events(batch_id,event_id,url,signal) VALUES(?,?,'','codename')").run(batch, id);
  const pending = aDelivery(db, { batchId: batch, destinationId: "telegram", status: "pending" });

  // Built, addressed, and still in flight: a message nobody has yet.
  const inFlight = eventEvidence(db, id);
  expect(inFlight?.batches.map((entry) => entry.id)).toEqual([batch]);
  expect(inFlight?.deliveries.map((entry) => entry.id)).toEqual([pending]);
  expect(inFlight?.reachedAReader).toBe(false);

  aDelivery(db, { batchId: batch, destinationId: "discord", status: "sent" });
  expect(eventEvidence(db, id)?.reachedAReader).toBe(true);
  db.close();
});

test("an event folded into a digest is found through the digest, not only through its batch", () => {
  const db = openDatabase(":memory:");
  const id = anEvent(db, { entityId: "gpt-6-sol" });
  const batch = aBatch(db, { digest: 1 });
  const delivery = aDelivery(db, { batchId: batch, status: "sent" });
  // The digest names its rows in `delivery_events`, and `batch_events` never mentions this one.
  db.query("INSERT INTO delivery_events(delivery_id,event_id) VALUES(?,?)").run(delivery, id);
  const answer = eventEvidence(db, id);
  expect(answer?.deliveries.map((entry) => entry.via)).toEqual(["digest"]);
  expect(answer?.reachedAReader).toBe(true);
  db.close();
});

test("the rules that held an event back are named beside it", () => {
  const db = openDatabase(":memory:");
  const id = anEvent(db, { entityId: "claude-opus-5-5-vertex", speaks: false });
  const batch = aBatch(db);
  db.query(
    `INSERT INTO suppressions(event_id,destination_id,batch_id,reason,detail,recorded_at)
     VALUES(?,'discord',?,'another_serving_of_a_known_model','claude opus 5 5 + vertex','2026-10-04T01:30:00.000Z')`,
  ).run(id, batch);
  const answer = eventEvidence(db, id);
  expect(answer?.standing.speaks).toBe(false);
  expect(answer?.standing.suppressedBy.map((entry) => entry.reason)).toEqual(["another_serving_of_a_known_model"]);
  expect(answer?.reachedAReader).toBe(false);
  db.close();
});

test("an id nothing was ever stored under answers with nothing rather than an empty shape", () => {
  const db = openDatabase(":memory:");
  expect(eventEvidence(db, 404)).toBeNull();
  db.close();
});
