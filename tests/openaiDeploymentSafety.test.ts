import { expect, test } from "bun:test";
import { signalClass } from "../src/events/signals.js";
import type { Event } from "../src/events/types.js";
import { deploymentSafetyCards } from "../src/sources/feeds.js";

/**
 * The hub's sitemap as it answered on 2026-09-29: every location is the development server the
 * site was built on, and a card is a slug with its sections underneath.
 */
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://localhost:4321/</loc></url>
  <url><loc>http://localhost:4321/gpt-6-astra/</loc></url>
  <url><loc>http://localhost:4321/gpt-6-astra/evaluations/</loc></url>
  <url><loc>http://localhost:4321/gpt-6-astra/child-safety/</loc></url>
  <url><loc>https://deploymentsafety.openai.com/gpt-6-1-sol/</loc></url>
  <url><loc>http://localhost:4321/rss.xml</loc></url>
</urlset>`;

test("a system card is read from the hub's own origin, whatever origin its sitemap prints", () => {
  const cards = deploymentSafetyCards(sitemap);
  expect(cards.map((card) => card.url)).toEqual([
    "https://deploymentsafety.openai.com/gpt-6-astra/",
    "https://deploymentsafety.openai.com/gpt-6-1-sol/",
  ]);
  // The sections under a card are the card, and the feed and the front page are not cards.
  expect(cards).toHaveLength(2);
  expect(cards[0]?.name).toBe("gpt 6 astra");
});

test("a system card is a safety item, like everything else published about how a model behaves", () => {
  const event = {
    id: 1,
    source: "openai-deployment-safety",
    stream: "news",
    entity_id: "https://deploymentsafety.openai.com/gpt-6-1-sol/",
    kind: "new",
    before_json: null,
    after_json: JSON.stringify({ name: "Addendum to GPT-6 Astra System Card: GPT-6.1 Sol" }),
    detected_at: "2026-09-29T00:00:00.000Z",
    snapshot_id: 1,
  } as unknown as Event;
  expect(signalClass(event)).toBe("safety");
});
