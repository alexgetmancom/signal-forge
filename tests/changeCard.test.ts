import { expect, test } from "bun:test";
import { type Banner, bannerPng } from "../src/events/render/banner.js";
import { eventEmbed } from "../src/events/render/discord.js";
import type { Event } from "../src/events/types.js";

const page = {
  id: 2,
  source: "anthropic-news",
  stream: "pages",
  entity_id: "https://anthropic.com/news/claude-discovers-novel-enzyme-system",
  kind: "new",
  after_json: JSON.stringify({
    name: "Claude discovers novel enzyme system",
    path: "/news/claude-discovers-novel-enzyme-system",
    section: "news",
  }),
  detected_at: "2026-09-23T18:39:00.000Z",
} as unknown as Event;

test("a new page is quoted by its picture and keeps its own address out of the card", () => {
  const embed = eventEmbed(page, "https://anthropic.com/news/claude-discovers-novel-enzyme-system");
  const banner = embed.banner as Banner;
  expect(banner.title).toBe("Claude discovers novel enzyme system");
  expect(banner.change).toEqual({ mark: "+", where: "On the maker's own site" });
  expect(banner.eyebrow).toBe("Anthropic · news · Sep 23, 2026");
  // The path and the section are our own bookkeeping: the card links to the page already.
  expect(embed.fields).toBeUndefined();
});

test("a change banner draws as a PNG", async () => {
  const png = await bannerPng(
    {
      filename: "change.png",
      eyebrow: "OpenAI · Codex docs · Sep 23, 2026",
      title: "gpt-6-sol-max is available on the Pro plan",
      chips: [],
      vendor: "OpenAI",
      logo: "openai.png",
      change: { mark: "+", where: "Added to /docs/models" },
    },
    "alexgetman.com",
  );
  expect([...png.slice(1, 4)].map((byte) => String.fromCharCode(byte)).join("")).toBe("PNG");
});

test("a feed row with no post behind it gets no picture", () => {
  const bare = { ...page, source: "kimi-docs", stream: "news", after_json: JSON.stringify({ name: "Kimi Code CLI" }) };
  expect(eventEmbed(bare as Event, "u").banner).toBeUndefined();
});
