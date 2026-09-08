import { afterEach, expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import {
  type Collection,
  canonical,
  collapseDetails,
  MAX_DETAIL_LINES,
  renderEvent,
  saveCollection,
  splitMessage,
} from "../src/events.js";
import { openDatabase } from "../src/storage/database.js";

const db = openDatabase(":memory:");
afterEach(() =>
  db.exec(
    "DELETE FROM deliveries; DELETE FROM batches; DELETE FROM events; DELETE FROM change_candidates; DELETE FROM records; DELETE FROM snapshots; DELETE FROM sources;",
  ),
);
const targets: Destination[] = [
  { id: "tg", platform: "telegram", chatId: "-100123", topicId: 7, streams: ["openrouter"] },
  { id: "dc", platform: "discord", channelId: "123", streams: ["openrouter"] },
  { id: "news", platform: "discord", channelId: "456", streams: ["news"] },
];
const collection = (ids: string[]): Collection => ({
  source: "openrouter",
  stream: "openrouter",
  url: "https://openrouter.ai",
  raw: ids,
  records: ids.map((id) => ({ id, name: id })),
});
test("first snapshot is quiet, new records fan out exactly once", () => {
  expect(saveCollection(db, collection(["a"]), targets)).toBe(0);
  expect(saveCollection(db, collection(["a", "b"]), targets)).toBe(1);
  expect(saveCollection(db, collection(["a", "b"]), targets)).toBe(0);
  expect(db.query("SELECT destination_id FROM deliveries ORDER BY id").all()).toEqual([
    { destination_id: "tg" },
    { destination_id: "dc" },
  ]);
});
test("removal needs two observations; reappearance is a new event", () => {
  saveCollection(db, collection(["a", "b"]), []);
  expect(saveCollection(db, collection(["a"]), [])).toBe(0);
  expect(saveCollection(db, collection(["a"]), [])).toBe(1);
  expect(saveCollection(db, collection(["a"]), [])).toBe(0);
  expect(saveCollection(db, collection(["a", "b"]), [])).toBe(1);
  expect(db.query("SELECT kind FROM events ORDER BY id").all()).toEqual([{ kind: "removed" }, { kind: "new" }]);
});
test("temporary disappearance does not publish removal", () => {
  saveCollection(db, collection(["a", "b"]), []);
  saveCollection(db, collection(["a"]), []);
  expect(saveCollection(db, collection(["a", "b"]), [])).toBe(0);
  expect(saveCollection(db, collection(["a"]), [])).toBe(0);
});
test("invalid snapshots preserve known records", () => {
  saveCollection(db, collection(["a"]), []);
  expect(() => saveCollection(db, collection([]), [])).toThrow("empty");
  expect(() => saveCollection(db, collection(["a", "a"]), [])).toThrow("duplicate");
  expect(db.query("SELECT id FROM records").all()).toEqual([{ id: "a" }]);
});
test("changed metadata preserves before and after; key order has no effect", () => {
  const c = collection(["a"]);
  c.records[0] = { id: "a", name: "a", pricing: { input: 1, output: 2 } };
  saveCollection(db, c, []);
  c.records[0] = { name: "a", id: "a", pricing: { output: 2, input: 1 } };
  expect(saveCollection(db, c, [])).toBe(0);
  c.records[0] = { id: "a", name: "a", pricing: { input: 2, output: 2 } };
  expect(saveCollection(db, c, [])).toBe(1);
  const event = db
    .query<{ before_json: string; after_json: string }, []>("SELECT before_json,after_json FROM events")
    .get();
  expect(JSON.parse(event?.before_json ?? "{}").pricing.input).toBe(1);
  expect(JSON.parse(event?.after_json ?? "{}").pricing.input).toBe(2);
});
test("confirmed changes suppress one-observation catalog jitter", () => {
  const c = { ...collection(["a"]), confirmChanges: true };
  c.records[0] = { id: "a", name: "A", pricing: { prompt: 1 } };
  saveCollection(db, c, []);
  c.records[0] = { id: "a", name: "A", pricing: { prompt: 2 } };
  expect(saveCollection(db, c, [])).toBe(0);
  c.records[0] = { id: "a", name: "A", pricing: { prompt: 1 } };
  expect(saveCollection(db, c, [])).toBe(0);
  c.records[0] = { id: "a", name: "A", pricing: { prompt: 2 } };
  expect(saveCollection(db, c, [])).toBe(0);
  expect(saveCollection(db, c, [])).toBe(1);
});
test("append-only feeds do not remove older entries or reannounce edited entries", () => {
  saveCollection(db, { ...collection(["a"]), appendOnly: true }, []);
  expect(saveCollection(db, { ...collection([]), appendOnly: true }, [])).toBe(0);
  expect(saveCollection(db, { ...collection(["a", "b"]), appendOnly: true, silentIds: ["b"] }, [])).toBe(0);
});
test("event and fanout roll back together on queue failure", () => {
  saveCollection(db, collection(["a"]), []);
  db.exec(
    "CREATE TEMP TRIGGER reject_delivery BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT,'test queue failure'); END",
  );
  try {
    expect(() => saveCollection(db, collection(["a", "b"]), targets)).toThrow("queue failure");
  } finally {
    db.exec("DROP TRIGGER reject_delivery");
  }
  expect(db.query("SELECT id FROM records").all()).toEqual([{ id: "a" }]);
  expect(db.query("SELECT * FROM events").all()).toEqual([]);
});
test("message chunks preserve Unicode and platform limits", () => {
  const text = "🛰️".repeat(4000);
  const parts = splitMessage(text);
  expect(parts.join("")).toBe(text);
  expect(parts.every((p) => p.length <= 1900 && Buffer.from(p).toString("utf8") === p)).toBe(true);
  expect(canonical({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
});

test("Telegram copy displays readable prices and only changed parameters", async () => {
  const { renderEvent } = await import("../src/events.js");
  const event = {
    id: 1,
    source: "openrouter",
    stream: "openrouter",
    entity_id: "qwen/qwen3-14b",
    kind: "changed" as const,
    before_json: JSON.stringify({ id: "x", name: "Qwen", pricing: { prompt: "0.00000012" }, parameters: ["tools"] }),
    after_json: JSON.stringify({
      id: "x",
      name: "Qwen",
      pricing: { prompt: "0.0000002275" },
      parameters: ["tools", "structured_outputs"],
    }),
    detected_at: "2026-09-08T02:00:00Z",
  };
  const text = renderEvent(event, "https://openrouter.ai");
  expect(text).toContain("Input: $0.12 → $0.2275 / 1M tokens");
  expect(text).toContain("Parameters: + structured_outputs");
  expect(text).not.toContain('"prompt"');
  expect(text).toContain("02:00 UTC");
});

test("web copy hides routine strings but keeps product signals", async () => {
  const { meaningfulWebString } = await import("../src/events.js");
  expect(meaningfulWebString("Open in new tab")).toBe(false);
  expect(meaningfulWebString("Claude Code can now open a remote worktree")).toBe(true);
});

test("multiple changes form one message and hourly digest survives until due", async () => {
  const { prepareDeliveries } = await import("../src/events.js");
  const now = "2026-09-08T10:15:00Z";
  saveCollection(db, collection(["a"]), targets, now);
  saveCollection(db, collection(["a", "b", "c"]), targets, now);
  expect(db.query("SELECT COUNT(*) AS n FROM deliveries").get()).toEqual({ n: 2 });
  const body = db.query<{ body: string }, []>("SELECT body FROM deliveries LIMIT 1").get()?.body;
  expect(body).toContain("· 2");
  const c = collection(["a", "b", "c"]);
  c.records[0] = { id: "a", name: "a", description: "minor metadata" };
  saveCollection(db, c, targets, now);
  expect(db.query("SELECT COUNT(*) AS n FROM deliveries").get()).toEqual({ n: 2 });
  // Important changes must not wait behind a scheduled digest.
  c.records.push({ id: "d", name: "d" });
  saveCollection(db, c, targets, now);
  expect(db.query("SELECT COUNT(*) AS n FROM deliveries").get()).toEqual({ n: 4 });
  prepareDeliveries(db, Date.parse("2026-09-08T11:00:00Z"));
  prepareDeliveries(db, Date.parse("2026-09-08T11:00:00Z"));
  expect(db.query("SELECT COUNT(*) AS n FROM deliveries").get()).toEqual({ n: 6 });
});

test("each platform is paged by its own limit", () => {
  saveCollection(db, collection(["a"]), targets);
  const c = collection(["a", ...Array.from({ length: 12 }, (_, i) => `model-${i}`)]);
  c.records = c.records.map((r) => ({ ...r, description: "Details ".repeat(150) }));
  saveCollection(db, c, targets);
  const rows = db
    .query<{ body: string; destination_id: string }, []>("SELECT body,destination_id FROM deliveries")
    .all();

  const telegram = rows.filter((row) => row.destination_id === "tg");
  expect(telegram.length).toBeGreaterThan(1);
  for (const row of telegram) {
    // Telegram has no embeds, so the heading is repeated on every split part.
    expect(row.body).toStartWith("📡 Updates · OpenRouter");
    expect(row.body).toContain("#OpenRouter #Models");
    expect(row.body.length).toBeLessThanOrEqual(3900);
  }

  const discord = rows.filter((row) => row.destination_id !== "tg");
  expect(discord.length).toBeGreaterThan(1);
  discord.forEach((row, index) => {
    const payload = JSON.parse(row.body) as { content: string; embeds: unknown[] };
    // Ten embeds is Discord's own ceiling; the heading belongs on the first page only, because
    // the embeds below it already carry their own headings.
    expect(payload.embeds.length).toBeLessThanOrEqual(10);
    if (index === 0) expect(payload.content).toStartWith("📡 Updates · OpenRouter");
  });

  expect(db.query("SELECT DISTINCT source,stream FROM events").all()).toEqual([
    { source: "openrouter", stream: "openrouter" },
  ]);
});

test("timestamps let each platform speak its reader's clock", () => {
  const event = {
    id: 7,
    source: "openrouter",
    stream: "openrouter",
    entity_id: "vendor/model",
    kind: "new" as const,
    before_json: null,
    after_json: JSON.stringify({ id: "vendor/model", name: "Vendor: Model" }),
    detected_at: "2026-09-08T14:06:00.000Z",
  };
  // Discord renders this in the viewer's own timezone; a fixed zone cannot.
  expect(renderEvent(event, "https://example.com", undefined, "discord")).toContain("<t:1788876360:f>");
  expect(renderEvent(event, "https://example.com", undefined, "telegram")).toContain("08 Sep 14:06 UTC");
});

test("a rank change reads as a movement, not as two numbers", async () => {
  const { rankMove } = await import("../src/events.js");
  expect(rankMove(7, 5)).toBe("Rank 5 🔼 2 (was 7)");
  expect(rankMove(2, 6)).toBe("Rank 6 🔽 4 (was 2)");
});

test("a rewritten record is collapsed to a readable message instead of a wall of fields", () => {
  const before: Record<string, unknown> = { id: "m", name: "Model" };
  const after: Record<string, unknown> = { id: "m", name: "Model" };
  for (let index = 0; index < 20; index++) {
    before[`field${index}`] = "old";
    after[`field${index}`] = "new";
  }
  const event = {
    id: 1,
    source: "openrouter",
    stream: "api-models",
    entity_id: "m",
    kind: "changed" as const,
    before_json: JSON.stringify(before),
    after_json: JSON.stringify(after),
    detected_at: "2026-09-08T10:00:00.000Z",
  };
  const lines = renderEvent(event, "https://example.test").split("\n");
  const details = lines.slice(3, -3);
  expect(details).toHaveLength(MAX_DETAIL_LINES + 1);
  expect(details.at(-1)).toBe("…and 12 more changes not shown");
  // The link and the signature survive the collapse, so the reader can still reach the source.
  expect(lines.at(-1)).toContain("#1");
});
test("a single long value is trimmed rather than dropped", () => {
  const long = "x".repeat(900);
  expect(collapseDetails([long])[0]).toHaveLength(300);
  expect(collapseDetails(["short"])).toEqual(["short"]);
});
