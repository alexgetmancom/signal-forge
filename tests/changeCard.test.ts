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

test("a model's page is spelled as the maker spells it, and a sentence is left alone", () => {
  const model = {
    ...page,
    entity_id: "https://docs.claude.com/en/docs/about-claude/models/claude-opus-5-5",
    after_json: JSON.stringify({ name: "Claude opus 5 5" }),
  } as unknown as Event;
  const embed = eventEmbed(model, "u");
  // The slug loses the dot in the version and the capital on the model's name, and the card printed
  // both losses twice: once in the title and once, the size of a headline, on the picture.
  expect(embed.title).toBe("📄 New page: Claude Opus 5.5");
  expect((embed.banner as Banner).title).toBe("Claude Opus 5.5");
  expect(eventEmbed(page, "u").title).toBe("📄 New page: Claude discovers novel enzyme system");
});

test("a maker's changelog is its sentence once, on the picture", () => {
  const news = {
    id: 3,
    source: "moonshot-news",
    stream: "news",
    entity_id: "https://moonshot.ai/changelog/kimi-code-cli-v2-1-0",
    kind: "new",
    after_json: JSON.stringify({
      name: "Kimi Code CLI v2.1.0",
      summary: "A new experimental fullscreen interface. It scrolls independently.",
    }),
    detected_at: "2026-09-23T18:39:00.000Z",
  } as unknown as Event;
  const embed = eventEmbed(news, "u");
  const banner = embed.banner as Banner;
  expect(banner.title).toBe("A new experimental fullscreen interface.");
  // The same sentence stood above the picture as well, the smaller of the two copies.
  expect(embed.description).toBeUndefined();
  expect(embed.title).toContain("Kimi Code CLI v2.1.0");
});

test("a banner can carry the maker's mark behind its words", async () => {
  const banner: Banner = {
    filename: "b.png",
    eyebrow: "OpenAI · In the API · Sep 22, 2026",
    title: "GPT-6 Luna",
    chips: ["1M context"],
    vendor: "OpenAI",
    logo: "openai.png",
    watermark: { opacity: 0.05, size: 640 },
  };
  const marked = await bannerPng(banner, "alexgetman.com");
  const { watermark: _unmarked, ...bare } = banner;
  const plain = await bannerPng(bare, "alexgetman.com");
  expect(marked.length).toBeGreaterThan(0);
  // Off unless a card asks for it, so the picture every other banner draws is unchanged.
  expect(Buffer.from(marked).equals(Buffer.from(plain))).toBe(false);
});
