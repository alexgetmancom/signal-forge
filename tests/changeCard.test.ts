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

test("an interface string quotes the line that was added", () => {
  const event = {
    id: 3,
    source: "claude-web",
    stream: "web",
    entity_id: "strings",
    kind: "changed",
    before_json: JSON.stringify({ id: "s", name: "Public interface strings", strings: ["Ask Claude anything"] }),
    after_json: JSON.stringify({
      id: "s",
      name: "Public interface strings",
      strings: ["Ask Claude anything", "Opus 5.5 is available on the Max plan"],
    }),
    detected_at: "2026-09-23T18:00:00.000Z",
  } as unknown as Event;
  const banner = eventEmbed(event, "u").banner as Banner | undefined;
  expect(banner?.change?.mark).toBe("+");
  expect(banner?.title).toContain("Opus 5.5 is available on the Max plan");
});

test("a post is quoted by what it says, not by its version number", () => {
  const event = {
    id: 4,
    source: "kimi-code-changelog",
    stream: "news",
    entity_id: "v2.1.0",
    kind: "new",
    after_json: JSON.stringify({
      name: "Kimi Code CLI v2.1.0",
      summary: "A new experimental fullscreen interface: the transcript scrolls independently. Text can be selected.",
    }),
    detected_at: "2026-09-23T19:01:00.000Z",
  } as unknown as Event;
  const banner = eventEmbed(event, "u").banner as Banner;
  expect(banner.title).toBe("A new experimental fullscreen interface: the transcript scrolls independently.");
  expect(banner.change?.where).toBe("Kimi Code CLI v2.1.0");
});

test("a venue's shop-window flags are not facts about the model it lists", () => {
  const event = {
    id: 5,
    source: "opencode-zen",
    stream: "api-models",
    entity_id: "claude-opus-5-5",
    kind: "new",
    after_json: JSON.stringify({
      id: "claude-opus-5-5",
      name: "Claude Opus 5 5",
      model: "claude-opus-5-5",
      maker: "Anthropic",
      free: false,
      headline: false,
    }),
    detected_at: "2026-09-22T22:04:00.000Z",
  } as unknown as Event;
  const body = JSON.stringify(eventEmbed(event, "u"));
  expect(body).not.toContain("headline");
  expect(body).not.toContain("free");
});
