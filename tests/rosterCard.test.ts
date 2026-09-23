import { expect, test } from "bun:test";
import { type Banner, bannerPng } from "../src/events/render/banner.js";
import { eventEmbed, isRoster, rosterEmbed } from "../src/events/render/discord.js";
import { logoFiles } from "../src/events/render/logos.js";
import type { Event } from "../src/events/types.js";

const model = (id: string, name: string, source = "mimo"): Event & { url: string } => ({
  id: 1,
  source,
  stream: "api-models",
  entity_id: id,
  kind: "new",
  before_json: null,
  after_json: JSON.stringify({ id, name }),
  detected_at: "2026-09-21T19:45:00.000Z",
  url: "https://mimo.mi.com/docs/en-US/api/model/list-models",
});

test("models arriving together from one catalogue are one card that names every one", () => {
  const events = [
    model("mimo-v2.6-flash", "Mimo V2.6 Flash"),
    model("mimo-v2.6-pro", "Mimo V2.6 Pro"),
    model("mimo-v2.6-pro-ultraspeed", "Mimo V2.6 Pro Ultraspeed"),
  ];
  expect(isRoster(events)).toBe(true);
  const card = rosterEmbed(events, "brief");
  expect(card.title).toBe("🚀 3 new Xiaomi models");
  // Xiaomi's own catalogue: a launch, so the maker's tile is in the banner rather than the corner.
  expect(card.image).toEqual({ url: `attachment://${(card.banner as Banner).filename}` });
  expect(card.banner).toMatchObject({
    title: "Mimo V2.6",
    chips: ["Flash", "Pro", "Pro Ultraspeed"],
    logo: "xiaomi.png",
  });
  expect(card.color).toBe(0xff6900);
  for (const id of ["mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed"])
    expect(String(card.description)).toContain(`\`${id}\``);
});

test("one model, or models from two catalogues, are not a roster", () => {
  expect(isRoster([model("a", "A")])).toBe(false);
  expect(isRoster([model("a", "A"), model("b", "B", "openrouter")])).toBe(false);
});

test("a launch banner draws as a PNG", async () => {
  const png = await bannerPng({
    filename: "banner-x.png",
    eyebrow: "New model · xAI",
    title: "Grok 4.7",
    chips: ["500K context", "$2 in · $10 out"],
    vendor: "xAI",
    logo: "xai.png",
  });
  expect([...png.slice(1, 4)].map((byte) => String.fromCharCode(byte)).join("")).toBe("PNG");
});

test("a signature is drawn on a launch banner and left off a number's corner", async () => {
  const banner: Banner = {
    filename: "banner-x.png",
    eyebrow: "Stealth launch",
    title: "Space Bunny",
    chips: ["free"],
    vendor: "Unknown",
    logo: null,
  };
  const plain = await bannerPng(banner);
  const signed = await bannerPng(banner, "alexgetman.com");
  expect(signed.length).not.toBe(plain.length);
  // The corner belongs to the number, so a reset banner is drawn the same either way.
  const hero = { ...banner, hero: { text: "12h", caption: "until reset" } };
  expect((await bannerPng(hero, "alexgetman.com")).length).toBe((await bannerPng(hero)).length);
});

test("a banner in a payload is not looked for among the logos", () => {
  const payload = {
    embeds: [{ image: { url: "attachment://banner-x.png" }, thumbnail: { url: "attachment://xai.png" } }],
  };
  expect(logoFiles(payload).map((file) => file.filename)).toEqual(["xai.png"]);
});

test("a card read for one number draws that number big: a price's move, a debut's place", async () => {
  const price = eventEmbed(
    {
      ...model("anthropic/claude-sonnet-4.6", "Anthropic: Claude Sonnet 4.6", "openrouter"),
      stream: "openrouter",
      kind: "changed",
      before_json: JSON.stringify({ id: "anthropic/claude-sonnet-4.6", pricing: { completion: "0.000015" } }),
      after_json: JSON.stringify({ id: "anthropic/claude-sonnet-4.6", pricing: { completion: "0.0000075" } }),
    },
    "https://openrouter.ai",
  );
  expect((price.banner as Banner).hero).toMatchObject({ text: "−50%", caption: "cheaper" });
  expect((price.banner as Banner).chips).toEqual(["$15 → $7.5 per 1M output"]);
  expect(price.thumbnail).toBeUndefined();
  const debut = eventEmbed(
    {
      ...model("gemini-3.8-flash", "Gemini 3.8 Flash", "arena-leaderboards"),
      stream: "leaderboards",
      after_json: JSON.stringify({ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", rank: 3, category: "Text" }),
    },
    "https://lmarena.ai",
  );
  expect((debut.banner as Banner).hero).toMatchObject({ text: "#3", caption: "Arena · Text" });
  const png = await bannerPng(debut.banner as Banner);
  expect(png.length).toBeGreaterThan(10_000);
});

test("a week's arrivals are drawn as one 16:9 poster", async () => {
  const png = await bannerPng({
    filename: "week.png",
    eyebrow: "The week in models · Sep 15 – Sep 21",
    title: "4 new models",
    chips: [],
    vendor: "OpenAI",
    logo: null,
    rows: [
      { vendor: "OpenAI", logo: "openai.png", names: ["GPT-6", "GPT-6 Mini"] },
      { vendor: "Xiaomi", logo: "xiaomi.png", names: ["MiMo V2.6 Pro", "MiMo V2.6 Flash"] },
    ],
  });
  // PNG height lives in the IHDR chunk at bytes 20..23.
  expect(new DataView(png.buffer, png.byteOffset).getUint32(20)).toBe(675);
});

test("a picture quotes the rates a model is chosen by and keeps the cache sheet in the text", () => {
  const event = {
    id: 1,
    source: "openai",
    stream: "api-models",
    entity_id: "gpt-6-sol",
    kind: "new",
    after_json: JSON.stringify({
      id: "gpt-6-sol",
      name: "GPT-6 Sol",
      context: 1_000_000,
      pricing: { input: "0.000002", output: "0.00001", input_cache_read: "0.0000002" },
    }),
    detected_at: "2026-09-22T17:59:00.000Z",
  } as unknown as Event;
  const embed = eventEmbed(event, "u");
  const banner = embed.banner as Banner;
  expect(banner.chips).toEqual(["1M context", "$2 in · $10 out"]);
  // White is no glow at all on a dark backdrop, so OpenAI's near-white is lit neutrally.
  expect(banner.glow).toBe(0xe6e6e6);
  expect(String(embed.description)).toContain("cache read");
});
