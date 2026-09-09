import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { deliverPending } from "../src/delivery.js";
import { requireDeliveryVerification } from "../src/deliveryVerification.js";
import { listActionableIssues } from "../src/issues.js";
import { operations } from "../src/operations.js";
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
  ).run(JSON.stringify({ id: "dc", platform: "discord", channelId: "123", streams: ["news"] }));
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
  const listed = operations(db, config).deliveries_needing_verification.handler({ limit: 20 });
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
