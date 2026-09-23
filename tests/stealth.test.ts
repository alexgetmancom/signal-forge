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

test("the card names the model and the venues, and leaves the rest to the picture", () => {
  const embed = eventEmbed(
    {
      ...venue("opencode-go", zen),
      elsewhere: ["opencode-zen", "openrouter"],
      // OpenCode's own row carries no context and no modalities; models.dev held both.
      borrowed: { context: 1_048_576, input: ["image", "text", "video"] },
    } as never,
    "u",
  );
  expect(embed.title).toBe("🚀 Space Bunny is out — free on OpenCode Zen");
  expect(embed.description).toBe("Also on OpenRouter and OpenCode Go\n`space-bunny-free`");
  // Nothing the picture says is said again in the text, and no field at all.
  expect(embed.fields).toBeUndefined();
  const body = JSON.stringify(embed);
  expect(body).not.toContain("headline");
  expect(body).not.toContain('"yes"');
  expect(body).not.toContain("Already out");
  const banner = embed.banner as { eyebrow: string; chips: string[]; stealth?: true };
  // The word its readers use, short enough to clear the light thrown into that corner.
  expect(banner.eyebrow).toBe("Stealth · Sep 23");
  expect(banner.chips).toEqual(["free", "1M context", "image, text, video"]);
  // A model nobody claims gets a picture of its own rather than a violet copy of a launch.
  expect(banner.stealth).toBe(true);
});

test("the stripe, the picture's glow and the footer tell one story", () => {
  const embed = eventEmbed(
    {
      ...venue("opencode-go", zen),
      elsewhere: ["opencode-zen", "openrouter"],
    } as never,
    "u",
  );
  const banner = embed.banner as { glow: number };
  // Violet, because nobody has put their name on it, and the same violet in both places.
  expect(embed.color).toBe(0x8b5cf6);
  expect(banner.glow).toBe(embed.color as number);
  // The card leads with Zen, so the footer credits Zen rather than whichever venue tripped it.
  expect((embed.footer as { text: string }).text).toContain("OpenCode Zen");
  expect((embed.footer as { text: string }).text).not.toContain("OpenCode Go");
});
