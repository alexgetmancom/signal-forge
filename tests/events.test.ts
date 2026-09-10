import { afterEach, expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import {
  type Collection,
  canonical,
  collapseDetails,
  type Event,
  eventEmbed,
  hasNotificationContent,
  isRoutine,
  MAX_DETAIL_LINES,
  prepareDeliveries,
  type RecordData,
  renderEvent,
  saveCollection,
  splitMessage,
} from "../src/events.js";
import { openDatabase } from "../src/storage/database.js";

const db = openDatabase(":memory:");
afterEach(() =>
  db.exec(
    "DELETE FROM deliveries; DELETE FROM lifecycle_reminders; DELETE FROM hypothesis_events; DELETE FROM model_fact_conflicts; DELETE FROM model_fact_fields; DELETE FROM model_facts; DELETE FROM hypotheses; DELETE FROM lifecycle_deadlines; DELETE FROM batch_targets; DELETE FROM batch_events; DELETE FROM batches; DELETE FROM summaries; DELETE FROM events; DELETE FROM change_candidates; DELETE FROM records; DELETE FROM snapshots; DELETE FROM sources;",
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
  expect(() => saveCollection(db, { ...collection(["a"]), records: [{ id: "", name: "A" }] }, [])).toThrow(
    "invalid normalized record",
  );
  expect(() => saveCollection(db, { ...collection(["a"]), records: [{ id: "a", name: "" }] }, [])).toThrow(
    "invalid normalized record",
  );
  expect(db.query("SELECT id FROM records").all()).toEqual([{ id: "a" }]);
});

test("a suspicious full-catalogue shrink preserves the last known-good records", () => {
  saveCollection(db, collection(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]), []);
  expect(() => saveCollection(db, collection(["a", "b", "c", "d"]), [])).toThrow("Collection degraded");
  expect(db.query("SELECT id FROM records ORDER BY id").all()).toEqual(
    ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((id) => ({ id })),
  );
  expect(db.query("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
});

test("append-only collections are exempt from shrinkage protection", () => {
  saveCollection(db, { ...collection(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]), appendOnly: true }, []);
  expect(saveCollection(db, { ...collection(["a", "b", "c", "d"]), appendOnly: true }, [])).toBe(0);
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
  expect(text).toContain("Input: $0.12 → $0.23 / 1M tokens");
  expect(text).toContain("Parameters: + structured_outputs");
  expect(text).not.toContain('"prompt"');
  expect(text).toContain("02:00 UTC");
});

test("web copy hides routine strings but keeps product signals", async () => {
  const { meaningfulWebString } = await import("../src/events.js");
  expect(meaningfulWebString("Open in new tab")).toBe(false);
  expect(meaningfulWebString("Claude Code can now open a remote worktree")).toBe(true);
});

test("documentation diffs normalize Markdown and suppress boilerplate-only changes", () => {
  const event = {
    id: 10,
    source: "codex-docs",
    stream: "web",
    entity_id: "https://learn.chatgpt.com/docs/example.md",
    kind: "changed" as const,
    before_json: JSON.stringify({ name: "Example", strings: ["Open in new tab"] }),
    after_json: JSON.stringify({
      name: "Example",
      strings: ["Open in new tab", "- Claude Code can now open a remote worktree"],
    }),
    detected_at: "2026-09-08T14:06:00.000Z",
  };
  const text = renderEvent(event, "https://developers.openai.com/codex/");
  expect(text).toContain("+ Claude Code can now open a remote worktree");
  expect(text).not.toContain("+ - Claude Code");
  expect(eventEmbed(event, "https://developers.openai.com/codex/")).toMatchObject({
    author: { name: "DOCUMENTATION · OPENAI" },
  });
  expect(JSON.stringify(eventEmbed(event, "https://developers.openai.com/codex/"))).not.toContain("Full report");
  expect(
    renderEvent(event, "https://developers.openai.com/codex/", "telegram", "The docs add remote worktree support."),
  ).toContain("AI summary: The docs add remote worktree support.");

  const boilerplateOnly = { ...event, after_json: JSON.stringify({ name: "Example", strings: ["Open in new tab"] }) };
  expect(hasNotificationContent(boilerplateOnly, "https://developers.openai.com/codex/")).toBe(false);
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

test("one story becomes one cross-source digest with every evidence link", () => {
  const local = openDatabase(":memory:");
  const destinations: Destination[] = [
    { id: "tg", platform: "telegram", chatId: "-100123", streams: ["openrouter", "api-models"] },
    { id: "dc", platform: "discord", channelId: "123", streams: ["openrouter", "api-models"] },
  ];
  const router: Collection = {
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai/models/gpt-5",
    raw: [],
    records: [{ id: "gpt-5", name: "GPT-5", maker: "OpenAI", pricing: { prompt: "1" } }],
  };
  const api: Collection = {
    source: "openai",
    stream: "api-models",
    url: "https://api.openai.com/models/gpt-5",
    raw: [],
    records: [{ id: "gpt-5", name: "GPT-5", maker: "OpenAI", context: 128000 }],
  };
  saveCollection(local, router, destinations, "2026-09-08T09:00:00Z");
  saveCollection(local, api, destinations, "2026-09-08T09:05:00Z");
  router.records = [{ id: "gpt-5", name: "GPT-5", maker: "OpenAI", pricing: { prompt: "2" } }];
  api.records = [{ id: "gpt-5", name: "GPT-5", maker: "OpenAI", context: 256000 }];
  saveCollection(local, router, destinations, "2026-09-08T10:00:00Z");
  saveCollection(local, api, destinations, "2026-09-08T10:05:00Z");

  expect(local.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM batches WHERE digest=1").get()).toEqual({
    count: 1,
  });
  prepareDeliveries(local, Date.parse("2026-09-08T11:00:00Z"));
  expect(local.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM deliveries").get()).toEqual({ count: 2 });

  const telegram = local
    .query<{ body: string }, [string]>("SELECT body FROM deliveries WHERE destination_id=?")
    .get("tg")?.body;
  expect(telegram).toContain("1 story in the last hour");
  expect(telegram).toContain("OpenRouter");
  expect(telegram).toContain("OpenAI API");
  expect(telegram).toContain("Evidence: https://openrouter.ai/models/gpt-5");
  expect(telegram).toContain("Evidence: https://api.openai.com/models/gpt-5");

  const discord = local
    .query<{ body: string }, [string]>("SELECT body FROM deliveries WHERE destination_id=?")
    .get("dc")?.body;
  const payload = JSON.parse(discord ?? "{}") as { embeds?: { description?: string }[] };
  expect(payload.embeds).toHaveLength(1);
  expect(payload.embeds?.[0]?.description).toContain("https://openrouter.ai/models/gpt-5");
  expect(payload.embeds?.[0]?.description).toContain("https://api.openai.com/models/gpt-5");
  local.close();
});

test("a later source does not repost a story already queued for the same destination", () => {
  const local = openDatabase(":memory:");
  const destination: Destination = {
    id: "dc",
    platform: "discord",
    channelId: "123",
    streams: ["arena", "openrouter"],
  };
  const arena: Collection = {
    source: "arena",
    stream: "arena",
    url: "https://arena.ai",
    raw: [],
    records: [{ id: "existing-arena", name: "Existing Arena Model" }],
  };
  const router: Collection = {
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai",
    raw: [],
    records: [{ id: "existing-router", name: "Existing Router Model" }],
  };
  saveCollection(local, arena, [destination], "2026-09-10T08:00:00.000Z");
  saveCollection(local, router, [destination], "2026-09-10T08:00:00.000Z");
  arena.records.push({ id: "gpt-6", name: "GPT-6", model: "gpt-6", maker: "OpenAI" });
  saveCollection(local, arena, [destination], "2026-09-10T08:05:00.000Z");
  router.records.push({ id: "gpt-6", name: "GPT-6", maker: "OpenAI" });
  saveCollection(local, router, [destination], "2026-09-10T08:10:00.000Z");
  expect(local.query("SELECT COUNT(*) AS count FROM deliveries").get()).toEqual({ count: 1 });
  expect(local.query("SELECT COUNT(*) AS count FROM events WHERE entity_id='gpt-6'").get()).toEqual({ count: 2 });
  local.close();
});

test("a cross-stream digest stays scoped to each destination", () => {
  const local = openDatabase(":memory:");
  const destinations: Destination[] = [
    { id: "models", platform: "discord", channelId: "123", streams: ["openrouter"] },
    { id: "benchmarks", platform: "discord", channelId: "456", streams: ["leaderboards"] },
  ];
  const router: Collection = {
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai/models",
    raw: [],
    records: [{ id: "router-model", name: "Router model", pricing: { prompt: "1" } }],
  };
  const leaderboard: Collection = {
    source: "arena-leaderboards",
    stream: "leaderboards",
    url: "https://arena.ai/leaderboard",
    raw: [],
    records: [{ id: "leaderboard-model", name: "Leaderboard model", rank: 2, score: 1 }],
  };
  saveCollection(local, router, destinations, "2026-09-08T09:00:00Z");
  saveCollection(local, leaderboard, destinations, "2026-09-08T09:05:00Z");
  router.records = [{ id: "router-model", name: "Router model", pricing: { prompt: "2" } }];
  leaderboard.records = [{ id: "leaderboard-model", name: "Leaderboard model", rank: 1, score: 2 }];
  saveCollection(local, router, destinations, "2026-09-08T10:00:00Z");
  saveCollection(local, leaderboard, destinations, "2026-09-08T10:05:00Z");

  prepareDeliveries(local, Date.parse("2026-09-08T11:00:00Z"));
  const rows = local
    .query<{ destination_id: string; body: string }, []>(
      "SELECT destination_id,body FROM deliveries ORDER BY destination_id",
    )
    .all();
  expect(rows).toHaveLength(2);
  const bodies = new Map(
    rows.map((row) => [row.destination_id, JSON.parse(row.body) as { embeds: { title: string }[] }]),
  );
  expect(bodies.get("models")?.embeds.map((embed) => embed.title)).toEqual(["Router model"]);
  expect(bodies.get("benchmarks")?.embeds.map((embed) => embed.title)).toEqual(["Leaderboard model"]);
  local.close();
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
    expect(row.body).toStartWith("📡 OpenRouter · 12 updates");
    expect(row.body.length).toBeLessThanOrEqual(3900);
  }

  const discord = rows.filter((row) => row.destination_id !== "tg");
  expect(discord.length).toBeGreaterThan(1);
  discord.forEach((row, index) => {
    const payload = JSON.parse(row.body) as { content: string; embeds: unknown[] };
    // Ten embeds is Discord's own ceiling; the heading belongs on the first page only, because
    // the embeds below it already carry their own headings.
    expect(payload.embeds.length).toBeLessThanOrEqual(10);
    // Only the first page carries a heading, and only because this batch holds twelve events.
    if (index === 0) expect(payload.content).toStartWith("📡 OpenRouter · 12 updates");
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
  expect(renderEvent(event, "https://example.com", "discord")).toContain("<t:1788876360:f>");
  expect(renderEvent(event, "https://example.com", "telegram")).toContain("08 Sep 14:06 UTC");
});

test("notifications expose source confidence", () => {
  const event = {
    id: 8,
    source: "openai",
    stream: "api-models",
    entity_id: "gpt-6",
    kind: "new" as const,
    before_json: null,
    after_json: JSON.stringify({ id: "gpt-6", name: "GPT-6" }),
    detected_at: "2026-09-08T14:06:00.000Z",
    confidence: "confirmed" as const,
    evidence_type: "api_catalogue" as const,
  };
  expect(renderEvent(event, "https://example.com")).toContain("Signal Forge · API catalogue · confirmed ·");
  expect(eventEmbed(event, "https://example.com")).toMatchObject({
    footer: { text: "Evidence: API catalogue · Confidence: confirmed" },
  });
});

test("Discord labels an AI summary before the raw evidence", () => {
  const event = {
    id: 9,
    source: "github:openai/codex:commits",
    stream: "github",
    entity_id: "commit-1",
    kind: "new" as const,
    before_json: null,
    after_json: JSON.stringify({
      id: "commit-1",
      name: "Record the originating model",
      summary: "src/history.rs (+4/−1)\n+model_info",
    }),
    detected_at: "2026-09-08T14:06:00.000Z",
  };
  const embed = eventEmbed(
    event,
    "https://github.com/openai/codex/commit/commit-1",
    "Conversation history stores the originating model.",
  ) as { description: string };
  expect(embed.description).toStartWith("AI summary: Conversation history stores the originating model.");
  expect(embed.description).toContain("Changes: 1 file · +4/−1 lines");
  expect(embed.description).not.toContain("model_info");
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
  expect(lines.at(-2)).toContain("https://");
  expect(lines.at(-1)).toStartWith("Signal Forge");
});
test("a single long value is trimmed rather than dropped", () => {
  const long = "x".repeat(900);
  expect(collapseDetails([long])[0]).toHaveLength(300);
  expect(collapseDetails(["short"])).toEqual(["short"]);
});

test("a new model pings the role of its vendor and nothing else", async () => {
  const { prepareDeliveries, saveCollection } = await import("../src/events.js");
  const db = openDatabase(":memory:");
  const destination: Destination = { id: "d", platform: "discord", channelId: "1", streams: ["api-models"] };
  const roles = { OpenAI: "111", Anthropic: "222" };
  const collection = {
    source: "openrouter",
    stream: "api-models",
    url: "https://example.test",
    raw: [],
    records: [{ id: "openai/gpt-6", name: "GPT-6", maker: "OpenAI" }],
  };
  saveCollection(db, collection, [destination], "2026-09-08T10:00:00.000Z", roles);
  collection.records.push({ id: "openai/gpt-6-mini", name: "GPT-6 mini", maker: "OpenAI" });
  saveCollection(db, collection, [destination], "2026-09-08T10:05:00.000Z", roles);
  prepareDeliveries(db, Date.parse("2026-09-08T10:05:00.000Z"), roles);
  const body = db.query<{ body: string }, []>("SELECT body FROM deliveries ORDER BY id DESC LIMIT 1").get();
  const payload = JSON.parse(body?.body ?? "{}") as {
    content: string;
    allowed_mentions?: { roles: string[] };
  };
  expect(payload.content).toContain("<@&111>");
  expect(payload.content).not.toContain("<@&222>");
  // The permission list names exactly the roles the message mentions, so a stray id cannot ping.
  expect(payload.allowed_mentions?.roles).toEqual(["111"]);
});
test("a capability edit travels without a ping", async () => {
  const { prepareDeliveries, saveCollection } = await import("../src/events.js");
  const db = openDatabase(":memory:");
  const destination: Destination = { id: "d", platform: "discord", channelId: "1", streams: ["api-models"] };
  const roles = { OpenAI: "111" };
  const records = [{ id: "openai/gpt-6", name: "GPT-6", maker: "OpenAI", selectable: true }];
  const collection = { source: "openrouter", stream: "api-models", url: "https://e.test", raw: [], records };
  saveCollection(db, collection, [destination], "2026-09-08T10:00:00.000Z", roles);
  records[0] = { id: "openai/gpt-6", name: "GPT-6", maker: "OpenAI", selectable: false };
  saveCollection(db, collection, [destination], "2026-09-08T10:05:00.000Z", roles);
  prepareDeliveries(db, Date.parse("2026-09-08T10:05:00.000Z"), roles);
  const body = db.query<{ body: string }, []>("SELECT body FROM deliveries ORDER BY id DESC LIMIT 1").get();
  const payload = JSON.parse(body?.body ?? "{}") as { content: string; allowed_mentions?: unknown };
  expect(payload.content).not.toContain("<@&");
  expect(payload.allowed_mentions).toBeUndefined();
});

test("a price move waits for the digest while a new capability does not", () => {
  const event = (before: Record<string, unknown>, after: Record<string, unknown>) => ({
    id: 1,
    source: "openrouter",
    stream: "openrouter",
    entity_id: "m",
    kind: "changed" as const,
    before_json: JSON.stringify(before),
    after_json: JSON.stringify(after),
    detected_at: "2026-09-08T10:00:00.000Z",
  });
  expect(isRoutine(event({ pricing: { prompt: "1" } }, { pricing: { prompt: "2" } }))).toBe(true);
  expect(isRoutine(event({ context: 100 }, { context: 200 }))).toBe(true);
  // A model gaining a capability or leaving the picker is news the moment it happens.
  expect(isRoutine(event({ selectable: true }, { selectable: false }))).toBe(false);
  expect(isRoutine(event({ pricing: { prompt: "1" }, name: "A" }, { pricing: { prompt: "2" }, name: "B" }))).toBe(
    false,
  );
});

test("entering a board is a sentence, waits for the digest, and pings nobody", () => {
  const event = {
    id: 116,
    source: "arena-leaderboards",
    stream: "leaderboards",
    entity_id: "text-to-image:overall:lina-f-alpha",
    kind: "new" as const,
    before_json: null,
    after_json: JSON.stringify({
      id: "text-to-image:overall:lina-f-alpha",
      name: "gpt-image-2.5-sunburst",
      category: "text-to-image/overall",
      maker: "OpenAI",
      rank: 1,
    }),
    detected_at: "2026-09-08T19:27:00.000Z",
  };
  const embed = eventEmbed(event, "https://arena.ai/leaderboard") as {
    description: string;
    author: { name: string };
  };
  expect(embed.description).toContain("Enters text-to-image/overall at rank 1");
  // The eyebrow already says OpenAI; the body must not say it again.
  expect(embed.author.name).toBe("LEADERBOARD · OPENAI");
  expect(embed.description).not.toContain("Maker:");
  // A scoreboard moving is not worth interrupting a few hundred people for.
  expect(isRoutine(event)).toBe(true);
});

test("leaderboard notifications keep top-five entries and meaningful movements only", () => {
  const event = (kind: "new" | "changed" | "removed", before: unknown, after: unknown) =>
    ({
      id: 116,
      source: "arena-leaderboards",
      stream: "leaderboards",
      entity_id: "website:overall:model",
      kind,
      before_json: before === null ? null : JSON.stringify(before),
      after_json: after === null ? null : JSON.stringify(after),
      detected_at: "2026-09-08T19:27:00.000Z",
    }) as const;
  expect(hasNotificationContent(event("new", null, { id: "m", name: "M", rank: 5 }), "https://example.test")).toBe(
    true,
  );
  expect(hasNotificationContent(event("new", null, { id: "m", name: "M", rank: 6 }), "https://example.test")).toBe(
    false,
  );
  expect(
    hasNotificationContent(
      event("changed", { id: "m", name: "M", rank: 12 }, { id: "m", name: "M", rank: 13 }),
      "https://example.test",
    ),
  ).toBe(false);
  expect(
    hasNotificationContent(
      event("changed", { id: "m", name: "M", rank: 12 }, { id: "m", name: "M", rank: 8 }),
      "https://example.test",
    ),
  ).toBe(true);
});

test("leaderboard sample timestamps stay in evidence without creating message changes", () => {
  const local = openDatabase(":memory:");
  const destination: Destination = { id: "d", platform: "discord", channelId: "1", streams: ["leaderboards"] };
  const record = (sampledAt: string, rank = 1): RecordData => ({
    id: "overall:model",
    name: "Model",
    category: "overall",
    modelKey: "model",
    rank,
    sampledAt,
  });
  const collection = {
    source: "arena-leaderboards",
    stream: "leaderboards",
    url: "https://arena.ai/leaderboard",
    raw: [],
    appendOnly: true,
    trackChanges: true,
    records: [record("2026-09-08T00:00:00.000Z")],
  };
  saveCollection(local, collection, [destination], "2026-09-08T00:00:00.000Z");
  collection.records = [record("2026-09-08T01:00:00.000Z")];
  saveCollection(local, collection, [destination], "2026-09-08T01:00:00.000Z");
  expect(local.query("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
  expect(local.query<{ body: string }, []>("SELECT body FROM records").get()?.body).toContain(
    "2026-09-08T01:00:00.000Z",
  );
  collection.records = [record("2026-09-08T02:00:00.000Z", 2)];
  saveCollection(local, collection, [destination], "2026-09-08T02:00:00.000Z");
  const event = local.query<Event, []>("SELECT * FROM events").get();
  if (!event) throw new Error("Expected a rank change event");
  expect(renderEvent(event, "https://arena.ai/leaderboard")).not.toContain("Sampled");
  local.close();
});

test("leaderboard vote-only changes and overlapping intervals do not create events", () => {
  const local = openDatabase(":memory:");
  const record = (votes: number, score: number, lower: number, upper: number): RecordData => ({
    id: "overall:model",
    name: "Model",
    category: "overall",
    modelKey: "model",
    rank: 1,
    score,
    scoreLower: lower,
    scoreUpper: upper,
    votes,
  });
  const make = (value: RecordData): Collection => ({
    source: "arena-leaderboards",
    stream: "leaderboards",
    url: "https://arena.ai/leaderboard",
    raw: value,
    appendOnly: true,
    trackChanges: true,
    records: [value],
  });
  saveCollection(local, make(record(10, 100, 95, 105)), []);
  saveCollection(local, make(record(20, 100, 95, 105)), []);
  saveCollection(local, make(record(30, 102, 97, 107)), []);
  expect(local.query("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
  saveCollection(local, make(record(31, 115, 110, 115)), []);
  expect(local.query("SELECT kind FROM events").all()).toEqual([{ kind: "changed" }]);
  local.close();
});

test("removed models use before evidence for vendor role mentions", () => {
  const local = openDatabase(":memory:");
  const destination: Destination = { id: "d", platform: "discord", channelId: "1", streams: ["openrouter"] };
  const other = { id: "other/model", name: "Other" };
  const records = [{ id: "openai/gpt-6", name: "GPT-6", maker: "OpenAI" }, other];
  const collection = { source: "openrouter", stream: "openrouter", url: "https://openrouter.ai", raw: [], records };
  saveCollection(local, collection, [destination], "2026-09-08T10:00:00.000Z", { OpenAI: "111" });
  collection.records = [other];
  saveCollection(local, collection, [destination], "2026-09-08T10:05:00.000Z", { OpenAI: "111" });
  saveCollection(local, collection, [destination], "2026-09-08T10:10:00.000Z", { OpenAI: "111" });
  const event = local.query("SELECT * FROM events WHERE kind='removed'").get() as Event;
  expect(hasNotificationContent(event, "https://openrouter.ai")).toBe(true);
  const body = local.query<{ body: string }, []>("SELECT body FROM deliveries").get()?.body ?? "";
  const payload = JSON.parse(body) as { content: string; allowed_mentions?: { roles?: string[] } };
  expect(payload.content).toContain("<@&111>");
  expect(payload.allowed_mentions?.roles).toEqual(["111"]);
  local.close();
});

test("a price that rounds away produces no message at all", () => {
  const db = openDatabase(":memory:");
  const destination: Destination = { id: "d", platform: "discord", channelId: "1", streams: ["openrouter"] };
  const priced = (prompt: string): RecordData => ({
    id: "deepseek/v4-pro",
    name: "DeepSeek V4 Pro",
    pricing: { prompt, completion: prompt },
  });
  const collection = {
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai",
    raw: [],
    records: [priced("0.000000949692")],
  };
  saveCollection(db, collection, [destination], "2026-09-08T10:00:00.000Z");
  // OpenRouter converts currencies, so a price drifts in the sixth decimal all day long.
  collection.records = [priced("0.000000948126")];
  saveCollection(db, collection, [destination], "2026-09-08T10:05:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-08T11:00:00.000Z"));
  expect(db.query<{ c: number }, []>("SELECT COUNT(*) c FROM deliveries").get()?.c).toBe(0);
  // The observation is still recorded; it simply is not worth a message.
  expect(db.query<{ c: number }, []>("SELECT COUNT(*) c FROM events WHERE kind='changed'").get()?.c).toBe(1);
});

test("catalogue ignores sub-cent drift but keeps meaningful cheap-model changes", () => {
  const small = {
    id: "deepseek/v4-pro",
    name: "DeepSeek V4 Pro",
    pricing: { prompt: "0.00000096", completion: "0.00000018", input_cache_read: "0.00000008" },
  };
  const smallAfter = {
    ...small,
    pricing: { prompt: "0.00000095", completion: "0.00000017", input_cache_read: "0.000000079" },
  };
  const makeEvent = (before: RecordData, after: RecordData): Event => ({
    id: 1,
    source: "openrouter",
    stream: "openrouter",
    entity_id: String(before.id),
    kind: "changed",
    before_json: JSON.stringify(before),
    after_json: JSON.stringify(after),
    detected_at: "2026-09-08T10:00:00.000Z",
  });
  const smallEvent = makeEvent(small, smallAfter);
  expect(hasNotificationContent(smallEvent, "https://openrouter.ai")).toBe(false);

  const meaningfulAfter = { ...small, pricing: { ...small.pricing, prompt: "0.00000109" } };
  const meaningfulEvent = makeEvent(small, meaningfulAfter);
  expect(hasNotificationContent(meaningfulEvent, "https://openrouter.ai")).toBe(true);
  expect(renderEvent(meaningfulEvent, "https://openrouter.ai")).toContain("Input: $0.96 → $1.09 / 1M tokens");
});

test("catalogue hides a two-cent expensive-model drift but keeps a sub-cent DeepSeek halving", () => {
  const makeEvent = (before: RecordData, after: RecordData, source = "openrouter"): Event => ({
    id: 1,
    source,
    stream: source === "deepseek-pricing" ? "api-models" : "openrouter",
    entity_id: String(before.id),
    kind: "changed",
    before_json: JSON.stringify(before),
    after_json: JSON.stringify(after),
    detected_at: "2026-09-10T08:00:00.000Z",
  });
  const glm = makeEvent(
    { id: "z-ai/glm-latest", name: "Z.ai: GLM Latest", pricing: { completion: "0.00000343" } },
    { id: "z-ai/glm-latest", name: "Z.ai: GLM Latest", pricing: { completion: "0.00000341" } },
  );
  expect(hasNotificationContent(glm, "https://openrouter.ai")).toBe(false);

  const deepSeek = makeEvent(
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", pricing: { inputCacheHitPeak: 0.014 } },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", pricing: { inputCacheHitPeak: 0.007 } },
    "deepseek-pricing",
  );
  expect(hasNotificationContent(deepSeek, "https://api-docs.deepseek.com")).toBe(true);
  expect(renderEvent(deepSeek, "https://api-docs.deepseek.com")).toContain(
    "Cache hit peak: $0.014 → $0.007 / 1M tokens",
  );
});

test("parameter-only catalogue churn and prerelease package channels stay out of delivery", () => {
  const parameterEvent: Event = {
    id: 1,
    source: "openrouter",
    stream: "openrouter",
    entity_id: "model",
    kind: "changed",
    before_json: JSON.stringify({ id: "model", name: "Model", parameters: ["tools"] }),
    after_json: JSON.stringify({ id: "model", name: "Model", parameters: ["tools", "temperature"] }),
    detected_at: "2026-09-10T08:00:00.000Z",
  };
  expect(hasNotificationContent(parameterEvent, "https://openrouter.ai")).toBe(false);
  expect(
    hasNotificationContent(
      { ...parameterEvent, stream: "packages", entity_id: "next", kind: "new", before_json: null },
      "https://npmjs.com",
    ),
  ).toBe(false);
});

test("catalogue keeps material token-limit changes and hides small corrections", () => {
  const changedContext = (from: number, to: number): Event => ({
    id: 1,
    source: "openrouter",
    stream: "openrouter",
    entity_id: "model",
    kind: "changed",
    before_json: JSON.stringify({ id: "model", name: "Model", context: from }),
    after_json: JSON.stringify({ id: "model", name: "Model", context: to }),
    detected_at: "2026-09-10T08:00:00.000Z",
  });
  expect(hasNotificationContent(changedContext(128_000, 131_072), "https://openrouter.ai")).toBe(false);
  expect(hasNotificationContent(changedContext(128_000, 256_000), "https://openrouter.ai")).toBe(true);
});

test("a failing source is asked less often, and a healthy one keeps its interval", async () => {
  const { due } = await import("../src/poller.js");
  const now = Date.parse("2026-09-08T12:00:00.000Z");
  const fiveMinutesAgo = "2026-09-08T11:55:00.000Z";
  // Healthy: a 300-second interval is up.
  expect(due(fiveMinutesAgo, 300, 0, now)).toBe(true);
  // Three failures means eight times the wait, so the same moment is far too early.
  expect(due(fiveMinutesAgo, 300, 3, now)).toBe(false);
  expect(due(fiveMinutesAgo, 300, 1, now)).toBe(false);
  // A source never asked is always due.
  expect(due(null, 3600, 5, now)).toBe(true);
});
