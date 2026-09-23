import { expect, test } from "bun:test";
import { eventEmbed } from "../src/events/render/discord.js";
import { isStealthLaunch, signalClass, stealthSubject } from "../src/events/signals.js";
import type { Event } from "../src/events/types.js";

const venue = (source: string, record: object, stream = "api-models"): Event =>
  ({
    id: 1,
    source,
    stream,
    entity_id: (record as { id: string }).id,
    kind: "new",
    after_json: JSON.stringify(record),
    detected_at: "2026-09-23T14:29:00.939Z",
  }) as unknown as Event;

const zen = {
  free: true,
  headline: true,
  id: "space-bunny-free",
  maker: "OpenCode",
  model: "space-bunny",
  name: "space-bunny-free",
};
const openRouter = {
  id: "stealth/space-bunny-alpha",
  name: "Space Bunny Alpha",
  context: 1_000_000,
  input: ["image", "text", "video"],
  output: ["text"],
  pricing: { prompt: "0", completion: "0" },
};

test("a free model no vendor claims is a launch, and a paid or named one is not", () => {
  expect(isStealthLaunch(venue("opencode-go", zen))).toBe(true);
  expect(signalClass(venue("opencode-go", zen))).toBe("launch");
  expect(signalClass(venue("openrouter", openRouter, "openrouter"))).toBe("launch");
  // The venue's free headline slot also holds models whose maker is on the tin.
  expect(
    isStealthLaunch(venue("opencode-zen", { ...zen, id: "deepseek-v4-flash-free", model: "deepseek-v4-flash" })),
  ).toBe(false);
  // A paid stealth row is a sighting, not a model the reader can try this hour.
  expect(
    isStealthLaunch(venue("openrouter", { ...openRouter, pricing: { prompt: "3", completion: "9" } }, "openrouter")),
  ).toBe(false);
});

test("every venue's spelling is one model", () => {
  expect(stealthSubject(venue("opencode-go", zen))).toBe("space-bunny");
  expect(stealthSubject(venue("openrouter", openRouter, "openrouter"))).toBe("space-bunny");
});

test("the card names the model, the free venue and the rest, and drops the venue's bookkeeping", () => {
  const embed = eventEmbed({ ...venue("opencode-go", zen), elsewhere: ["opencode-zen", "openrouter"] } as never, "u");
  expect(embed.title).toBe("🚀 Space Bunny is out — free on OpenCode Zen");
  expect(embed.description).toContain("Also on OpenRouter and OpenCode Go");
  const body = JSON.stringify(embed);
  expect(body).not.toContain("headline");
  expect(body).not.toContain('"yes"');
  expect(body).not.toContain("Already out");
  // The picture carries it, with nobody's brand on it.
  expect((embed.banner as { eyebrow: string }).eyebrow).toBe("Stealth · free on OpenCode Zen · Sep 23, 2026");
  expect((embed.banner as { chips: string[] }).chips).toContain("free");
});
