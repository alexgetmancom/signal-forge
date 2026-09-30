import { expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import { prepareDeliveries } from "../src/events/batching.js";
import { boardInterest, isTellableDebut } from "../src/events/boardSignals.js";
import { newsClass, opensByAnnouncing } from "../src/events/newsrooms.js";
import { notificationBlock } from "../src/events/notification.js";
import { saveCollection } from "../src/events/pipeline.js";
import { eventEmbed } from "../src/events/render/discord.js";
import type { Collection, Event } from "../src/events/types.js";
import { isAboutTheCompanyNotAModel, isMinorBoardMove } from "../src/events/worth.js";
import { openDatabase } from "../src/storage/database.js";

/**
 * Gemini 4 Argon, 2026-09-30, as production saw it. Every rule below was written against this
 * evening: the announcement reached no public channel, and both debuts outside the top three were
 * classed `debut` and then suppressed as movement.
 */
const debut = (category: string, rank: number): Event =>
  ({
    id: 1,
    source: "arena-leaderboards",
    stream: "leaderboards",
    entity_id: "gemini-4-argon-high",
    kind: "new",
    signal: "debut",
    detected_at: "2026-09-30T20:19:53.728Z",
    confidence: "observed",
    after_json: JSON.stringify({ id: "gemini-4-argon-high", name: "gemini-4-argon-high", category, rank, score: 1525 }),
    before_json: null,
  }) as unknown as Event;

const post = (name: string, description: string): Event =>
  ({
    id: 2,
    source: "gemini-models-blog",
    stream: "news",
    entity_id: "https://blog.google/gemini-4-argon/",
    kind: "new",
    signal: "launch",
    detected_at: "2026-09-30T20:05:09.890Z",
    confidence: "supported",
    after_json: JSON.stringify({ id: "https://blog.google/gemini-4-argon/", name, description, maker: "Google" }),
    before_json: null,
  }) as unknown as Event;

test("a debut in the leading places of a board people quote is told, not silenced as movement", () => {
  // Both gates, because they used to answer this with different numbers: `worth` suppressed
  // anything outside the top three and `notification` asked its own question beside it.
  for (const rank of [1, 8, 10]) {
    expect(isTellableDebut(debut("code/overall", rank))).toBe(true);
    expect(isMinorBoardMove(debut("code/overall", rank))).toBe(false);
    expect(notificationBlock(debut("code/overall", rank))).toBeNull();
  }
  // Below the leading places a new row is a row, and a board nobody quotes stays a sighting.
  expect(isTellableDebut(debut("code/overall", 11))).toBe(false);
  expect(isMinorBoardMove(debut("code/overall", 11))).toBe(true);
  expect(isTellableDebut(debut("code/tool-use", 2))).toBe(false);
});

test("the picture goes to the board these readers act on, not to the better number", () => {
  expect(boardInterest(debut("code/overall", 8))).toBeLessThan(boardInterest(debut("text/overall", 1)));
});

test("a maker announcing a model in the body of a post it headlined with a slogan", () => {
  const slogan = post(
    "Gemini 4 Argon: our next era of frontier intelligence",
    "Announcing Gemini 4 Argon, our frontier model.",
  );
  expect(opensByAnnouncing(JSON.parse(String(slogan.after_json)))).toBe(true);
  expect(newsClass(slogan, JSON.parse(String(slogan.after_json)))).toBe("launch");
  // The rule that suppressed it: a post naming no model this deployment knows, announcing none.
  expect(isAboutTheCompanyNotAModel(slogan, [])).toBe(false);

  // The word has to open the post. An essay that mentions announcing something in passing is an
  // essay, and the headline is still what a post is titled by.
  const essay = post("What we learned running frontier evaluations", "We spent a year announcing nothing.");
  expect(opensByAnnouncing(JSON.parse(String(essay.after_json)))).toBe(false);
  expect(newsClass(essay, JSON.parse(String(essay.after_json)))).not.toBe("launch");
});

test("the announcement card says the model, and keeps the maker's own sentence under its picture", () => {
  const embed = eventEmbed(
    post("Gemini 4 Argon: our next era of frontier intelligence", "Announcing Gemini 4 Argon, our frontier model."),
    "https://blog.google/gemini-4-argon/",
  ) as { title: string; description: string; banner: { title: string; eyebrow: string } };
  expect(embed.title).toBe("🚀 Google announced Gemini 4 Argon");
  // The name, not the slogan the headline trails it with.
  expect(embed.banner.title).toBe("Gemini 4 Argon");
  expect(embed.banner.eyebrow).toBe("Google · Announced · Sep 30");
  // A picture carrying only a name does not replace the sentence, the way a picture of a number does.
  expect(embed.description).toContain("Announcing Gemini 4 Argon");
});

test("an Artificial Analysis debut carries the two numbers it is quoted for", () => {
  const event = {
    id: 3,
    source: "artificial-analysis",
    stream: "leaderboards",
    entity_id: "d366dfa1",
    kind: "new",
    signal: "debut",
    detected_at: "2026-09-30T20:56:57.120Z",
    confidence: "observed",
    before_json: null,
    after_json: JSON.stringify({
      id: "d366dfa1",
      name: "Gemini 4 Argon (High)",
      maker: "Google",
      category: "artificial-analysis/quality",
      rank: 8,
      score: { artificial_analysis_intelligence_index: 52.6 },
      pricing: { input: 2, output: 10 },
    }),
  } as unknown as Event;
  const embed = eventEmbed(event, "https://artificialanalysis.ai/models") as {
    banner: { chips: string[]; hero: { text: string } };
  };
  expect(embed.banner.hero.text).toBe("#8");
  // Per million tokens, because that is the unit this site publishes in: read as per-token the
  // same 2 becomes a card claiming two million dollars.
  expect(embed.banner.chips).toEqual(["Index 52.6", "$2 in", "$10 out"]);
});

test("an announcement card names the model, not the maker's verb", () => {
  const embed = eventEmbed(
    { ...post("Introducing Claude Opus 5.5", "Claude Opus 5.5 is our most capable model."), source: "anthropic-news" },
    "https://www.anthropic.com/claude-opus-5-5",
  ) as { title: string; banner: { title: string } };
  expect(embed.title).toBe("🚀 Anthropic announced Claude Opus 5.5");
  expect(embed.banner.title).toBe("Claude Opus 5.5");
});

test("one arrival on two boards is one card, and the picture is the board these readers act on", () => {
  const db = openDatabase(":memory:");
  const wire: Destination = { id: "signals", platform: "discord", channelId: "1", signals: ["debut", "launch"] };
  const board: Collection = {
    source: "arena-leaderboards",
    stream: "leaderboards",
    url: "https://arena.example/leaderboard",
    raw: [],
    records: [
      { id: "text:overall:incumbent", name: "incumbent", category: "text/overall", rank: 1, score: 1500 },
      { id: "code:overall:incumbent", name: "incumbent", category: "code/overall", rank: 1, score: 1500 },
    ],
  };
  saveCollection(db, board, [wire], "2026-09-30T19:00:00.000Z");
  // One reading, one model, two boards: Argon entered Arena Text at #1 and Arena Code at #8 in the
  // same collection, and the two of them used to be a card and a suppression.
  board.records = [
    { id: "text:overall:argon", name: "gemini-4-argon-high", category: "text/overall", rank: 1, score: 1525 },
    { id: "text:overall:incumbent", name: "incumbent", category: "text/overall", rank: 2, score: 1500 },
    { id: "code:overall:argon", name: "gemini-4-argon-high", category: "code/overall", rank: 8, score: 1440 },
    { id: "code:overall:incumbent", name: "incumbent", category: "code/overall", rank: 1, score: 1500 },
  ];
  saveCollection(db, board, [wire], "2026-09-30T20:19:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-30T20:25:00.000Z"));

  const sent = db
    .query<{ body: string }, []>("SELECT body FROM deliveries")
    .all()
    .map(
      (row) =>
        JSON.parse(row.body) as {
          embeds: { title: string }[];
          banners: { hero?: { caption: string }; chips: string[] }[];
        },
    )
    .filter((message) => message.embeds.some((embed) => embed.title.includes("gemini-4-argon-high")));
  expect(sent).toHaveLength(1);
  const [message] = sent as [(typeof sent)[number]];
  // One card, not two, and not a thread card with no picture at all.
  expect(message.embeds).toHaveLength(1);
  expect(message.banners).toHaveLength(1);
  // The coding board carries the picture even though the text board carries the better number.
  expect(message.banners[0]?.hero?.caption).toBe("Arena · code");
  // The other board is not lost: it is a chip beside the score.
  expect(message.banners[0]?.chips).toContain("#1 text");
  db.close();
});
