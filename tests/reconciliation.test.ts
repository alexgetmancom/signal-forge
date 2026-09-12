import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { deliverPending } from "../src/delivery.js";
import { requireDeliveryVerification, resolveDeliveryVerification } from "../src/deliveryVerification.js";
import { listActionableIssues } from "../src/issues.js";
import { callOperation, operations } from "../src/operations.js";
import { openDatabase } from "../src/storage/database.js";

const config = loadConfig({
  CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname,
  TELEGRAM_BOT_TOKEN: "fake-telegram",
  DISCORD_BOT_TOKEN: "fake-discord",
});

function seedAmbiguousDelivery() {
  const db = openDatabase(":memory:");
  db.query("INSERT INTO batches(id,source,ready_at,sealed) VALUES(1,'test',0,1)").run();
  db.query(
    "INSERT INTO deliveries(id,batch_id,destination_id,destination_json,body,part,status,updated_at) VALUES(7,1,'dc',?,'already attempted',0,'ambiguous',100)",
  ).run(
    JSON.stringify({
      id: "dc",
      platform: "discord",
      channelId: "123",
      signals: ["launch", "codename", "evidence", "change"],
    }),
  );
  return db;
}

test("delivery verification records manual verification without sending again", async () => {
  const db = seedAmbiguousDelivery();
  const result = requireDeliveryVerification(db, 7, 200);
  expect(result).toEqual({
    id: 7,
    status: "verification_required",
    attempts: 1,
    destination: "dc",
    message:
      "No reliable read-back is available for this destination; verify the destination manually before deciding its outcome",
  });
  let requests = 0;
  await deliverPending(db, config, async () => {
    requests++;
    return Response.json({ id: "999" });
  });
  expect(requests).toBe(0);
  expect(
    db.query("SELECT status,verification_attempts,verification_source,last_verification_error FROM deliveries").get(),
  ).toEqual({
    status: "verification_required",
    verification_attempts: 1,
    verification_source: "manual",
    last_verification_error:
      "No reliable read-back is available for this destination; verify the destination manually before deciding its outcome",
  });
  db.close();
});

test("verification-required deliveries remain visible and never become sent", () => {
  const db = seedAmbiguousDelivery();
  requireDeliveryVerification(db, 7, 200);
  const listed = callOperation(operations(db, config), "deliveries_needing_verification", { limit: 20 });
  expect(listed).toEqual([
    expect.objectContaining({
      id: 7,
      status: "verification_required",
      verification_attempts: 1,
      last_verification_error:
        "No reliable read-back is available for this destination; verify the destination manually before deciding its outcome",
    }),
  ]);
  expect(listActionableIssues(db, config).find((issue) => issue.id === "delivery:7")).toMatchObject({
    kind: "delivery_ambiguous",
    severity: "critical",
  });
  expect(() => requireDeliveryVerification(db, 7, 300)).not.toThrow();
  expect(db.query("SELECT status,verification_attempts FROM deliveries").get()).toEqual({
    status: "verification_required",
    verification_attempts: 2,
  });
  db.close();
});

test("manual verification records the outcome and releases the same batch", async () => {
  const db = seedAmbiguousDelivery();
  db.query(
    "INSERT INTO deliveries(id,batch_id,destination_id,destination_json,body,part,status,updated_at) VALUES(8,1,'dc',?,'part 1',1,'pending',100)",
  ).run(
    JSON.stringify({
      id: "dc",
      platform: "discord",
      channelId: "123",
      signals: ["launch", "codename", "evidence", "change"],
    }),
  );
  requireDeliveryVerification(db, 7, 200);
  expect(resolveDeliveryVerification(db, 7, "sent", "12345", 300)).toEqual({
    id: 7,
    status: "sent",
    attempts: 0,
    destination: "dc",
    verifiedAt: "1970-01-01T00:00:00.300Z",
    message: "Manual verification recorded the delivery as sent",
  });
  let requests = 0;
  await deliverPending(db, config, async () => {
    requests++;
    return Response.json({ id: "999" });
  });
  expect(requests).toBe(1);
  expect(db.query("SELECT id,status,external_id FROM deliveries ORDER BY id").all()).toEqual([
    { id: 7, status: "sent", external_id: "12345" },
    { id: 8, status: "sent", external_id: "999" },
  ]);
  db.close();
});
