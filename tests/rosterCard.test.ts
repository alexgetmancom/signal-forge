import { expect, test } from "bun:test";
import { type Banner, bannerPng } from "../src/events/render/banner.js";
import { isRoster, rosterEmbed } from "../src/events/render/discord.js";
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

test("a banner in a payload is not looked for among the logos", () => {
  const payload = {
    embeds: [{ image: { url: "attachment://banner-x.png" }, thumbnail: { url: "attachment://xai.png" } }],
  };
  expect(logoFiles(payload).map((file) => file.filename)).toEqual(["xai.png"]);
});
