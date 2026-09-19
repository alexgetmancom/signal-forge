import { expect, test } from "bun:test";
import { readMessage, sentByChannel } from "../src/reports/news.js";
import { openDatabase } from "../src/storage/database.js";

test("a Discord body reads as its headline and embeds, without the transport", () => {
  const body = JSON.stringify({
    content: "🗞 Hourly digest · 2 stories\n<@&123>",
    embeds: [
      {
        author: { name: "OFFICIAL NEWS · OPENAI" },
        title: "🆕 GPT-6",
        description: "Out now.",
        url: "https://openai.com/x",
      },
      { author: { name: "ARENA" }, title: "🆕 parsley" },
    ],
  });
  expect(readMessage(body)).toEqual({
    headline: "🗞 Hourly digest · 2 stories",
    items: [
      { label: "OFFICIAL NEWS · OPENAI", title: "🆕 GPT-6", description: "Out now.", url: "https://openai.com/x" },
      { label: "ARENA", title: "🆕 parsley", description: null, url: null },
    ],
  });
});

test("a text card reads as its title, details and link, without tags or footer", () => {
  const body =
    "📡 Updates · OpenRouter · 1\n#OpenRouter #Models\n\n✏️ MiniMax: MiniMax M1\n\nInput: $0.4 → $0.55 / 1M tokens\nhttps://openrouter.ai/minimax/minimax-m1\nSignal Forge · 08 Sept, 14:09 UTC · #30";
  expect(readMessage(body)).toEqual({
    headline: "📡 Updates · OpenRouter · 1",
    items: [
      {
        label: null,
        title: "✏️ MiniMax: MiniMax M1",
        description: "Input: $0.4 → $0.55 / 1M tokens",
        url: "https://openrouter.ai/minimax/minimax-m1",
      },
    ],
  });
});

test("sent groups what each channel received, with titles, and counts what did not go", () => {
  const db = openDatabase(":memory:");
  db.run("PRAGMA foreign_keys=OFF");
  const card = (title: string) => JSON.stringify({ content: "", embeds: [{ author: { name: "ARENA" }, title }] });
  const insert = db.query(
    `INSERT INTO deliveries(id,batch_id,destination_id,destination_json,body,part,status,updated_at)
     VALUES(?,?,?,'{}',?,0,?,?)`,
  );
  insert.run(1, 1, "discord-scouts", card("🆕 parsley"), "sent", "2026-09-19T10:00:00.000Z");
  insert.run(2, 2, "discord-signals", card("✏️ GPT 5.6 Sol"), "sent", "2026-09-19T11:00:00.000Z");
  insert.run(3, 3, "discord-signals", card("later"), "pending", "2026-09-19T11:30:00.000Z");
  insert.run(4, 4, "discord-signals", card("old"), "sent", "2026-09-17T00:00:00.000Z");

  const report = sentByChannel(db, { hours: 24 }, Date.parse("2026-09-19T12:00:00.000Z"));
  expect(report.channels).toEqual([
    {
      destination: "discord-scouts",
      sent: 1,
      unsent: {},
      messages: [{ sentAt: "2026-09-19T10:00:00.000Z", headline: null, titles: ["🆕 parsley"] }],
    },
    {
      destination: "discord-signals",
      sent: 1,
      unsent: { pending: 1 },
      messages: [{ sentAt: "2026-09-19T11:00:00.000Z", headline: null, titles: ["✏️ GPT 5.6 Sol"] }],
    },
  ]);
  expect(
    sentByChannel(db, { hours: 24, destination: "discord-scouts" }, Date.parse("2026-09-19T12:00:00.000Z")).channels,
  ).toHaveLength(1);
  db.close();
});
