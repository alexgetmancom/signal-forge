import { expect, test } from "bun:test";
import { isRoster, rosterEmbed } from "../src/events/render/discord.js";
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
  expect(card.thumbnail).toEqual({ url: "attachment://xiaomi.png" });
  expect(card.color).toBe(0xff6900);
  for (const id of ["mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed"])
    expect(String(card.description)).toContain(`\`${id}\``);
});

test("one model, or models from two catalogues, are not a roster", () => {
  expect(isRoster([model("a", "A")])).toBe(false);
  expect(isRoster([model("a", "A"), model("b", "B", "openrouter")])).toBe(false);
});
