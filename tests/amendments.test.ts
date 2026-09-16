import { expect, test } from "bun:test";
import { applyCardAmendments, queueIncidentAmendments } from "../src/amendments.js";
import type { Destination } from "../src/config.js";
import { prepareDeliveries } from "../src/events/batching.js";
import { saveCollection } from "../src/events/pipeline.js";
import type { Collection } from "../src/events/types.js";
import { openDatabase } from "../src/storage/database.js";

const wire: Destination = { id: "wire", platform: "discord", channelId: "77", signals: ["launch"] };

test("a major outage's card is edited to say it ended, once, without a new message", async () => {
  const db = openDatabase(":memory:");
  const status = (stage: string): Collection => ({
    source: "status:openai",
    stream: "incidents",
    url: "https://status.openai.com",
    raw: [],
    resolveMissing: true,
    records: [
      { id: "anchor", name: "Earlier", impact: "none", stage: "resolved" },
      ...(stage ? [{ id: "01M2KQNE5C42NEZPX6V01NHH5W", name: "Elevated errors", impact: "major", stage }] : []),
    ],
  });
  saveCollection(db, status(""), [wire], "2026-09-15T23:40:00.000Z");
  saveCollection(db, status("investigating"), [wire], "2026-09-15T23:53:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-15T23:54:00.000Z"));
  db.query("UPDATE deliveries SET status='sent',external_id='123456'").run();
  saveCollection(db, status("resolved"), [wire], "2026-09-16T00:40:00.000Z");

  expect(queueIncidentAmendments(db, Date.parse("2026-09-16T00:41:00.000Z"))).toBe(1);
  expect(queueIncidentAmendments(db, Date.parse("2026-09-16T00:42:00.000Z"))).toBe(0);

  const calls: { url: string; method: string | undefined; body: Record<string, unknown> }[] = [];
  const request = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) });
    return Response.json({ id: "123456" });
  };
  await applyCardAmendments(db, { DISCORD_BOT_TOKEN: "t", destinations: [wire] } as never, request);
  await applyCardAmendments(db, { DISCORD_BOT_TOKEN: "t", destinations: [wire] } as never, request);

  expect(calls).toHaveLength(1);
  expect(calls[0]?.method).toBe("PATCH");
  expect(calls[0]?.url).toBe("https://discord.com/api/v10/channels/77/messages/123456");
  const embed = (calls[0]?.body.embeds as Record<string, unknown>[] | undefined)?.[0];
  expect(String(embed?.title)).toStartWith("✅ Resolved · ");
  expect(String(embed?.description)).toContain("Resolved <t:");
  expect(calls[0]?.body.allowed_mentions).toEqual({ parse: [] });
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM deliveries").get()?.n).toBe(1);
  db.close();
});
