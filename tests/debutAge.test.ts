import { expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import { prepareDeliveries } from "../src/events/batching.js";
import { isUnannouncedBoard } from "../src/events/boardSignals.js";
import { followsAnOldLaunch, launchNames, launchSightedAt } from "../src/events/debutAge.js";
import { notificationBlock } from "../src/events/notification.js";
import { saveCollection } from "../src/events/pipeline.js";
import type { Collection, Event } from "../src/events/types.js";
import { isMinorBoardMove } from "../src/events/worth.js";
import { openDatabase } from "../src/storage/database.js";
import { anEvent } from "./fixtures/build.js";

/**
 * gpt-6.1-sol-max, 2026-09-30 and 2026-10-02, as production saw it. One model, two boards, two days
 * apart: the coding debut at #3 is the card that was wanted and the vision debut at #10 is the one
 * the channel voted down.
 */
const debut = (category: string, rank: number, detectedAt: string): Event =>
  ({
    id: 1,
    source: "arena-leaderboards",
    stream: "leaderboards",
    entity_id: `${category.split("/")[0]}:overall:gpt-6.1-sol-max`,
    kind: "new",
    signal: "debut",
    detected_at: detectedAt,
    confidence: "observed",
    after_json: JSON.stringify({
      id: `${category.split("/")[0]}:overall:gpt-6.1-sol-max`,
      name: "gpt-6.1-sol-max",
      category,
      rank,
      score: 1290.6,
    }),
    before_json: null,
  }) as unknown as Event;

const CODE_DEBUT = "2026-09-30T16:45:04.185Z";
const VISION_DEBUT = "2026-10-02T16:18:48.753Z";

test("only the coding and text boards are announced; every other Arena board is a sighting", () => {
  expect(isUnannouncedBoard(debut("code/overall", 3, CODE_DEBUT))).toBe(false);
  expect(isMinorBoardMove(debut("code/overall", 3, CODE_DEBUT))).toBe(false);
  expect(notificationBlock(debut("code/overall", 3, CODE_DEBUT))).toBeNull();
  expect(isUnannouncedBoard(debut("text/overall", 1, CODE_DEBUT))).toBe(false);
  for (const board of ["vision/overall", "text-to-image/overall", "image-edit/overall", "search/overall"]) {
    // A first place on one of these is still the board nobody here acts on, not just a tenth place.
    for (const rank of [1, 10]) {
      expect(isUnannouncedBoard(debut(board, rank, VISION_DEBUT))).toBe(true);
      expect(isMinorBoardMove(debut(board, rank, VISION_DEBUT))).toBe(true);
      expect(notificationBlock(debut(board, rank, VISION_DEBUT))).toBe("A board this service does not announce");
    }
  }
});

test("a board entry is read for the model it ran, not the harness and effort the board names", () => {
  expect(launchNames("gpt-6.1-sol-max-code-codex-harness")).toContain("gpt-6.1-sol");
  expect(launchNames("claude-sonnet-5.5-xhigh")).toContain("claude-sonnet-5.5");
  // A reading without a digit is a word: `claude-opus` would match every Opus ever shipped.
  expect(launchNames("claude-opus-5.5-max")).not.toContain("claude-opus");
});

test("a debut within two days of the launch is told, and the same model's later board is not", () => {
  const db = openDatabase(":memory:");
  // OpenAI listing gpt-6.1-sol in its own API, which is the launch both debuts follow.
  anEvent(db, {
    source: "openai",
    stream: "api-models",
    entityId: "gpt-6.1-sol",
    detectedAt: "2026-09-29T17:13:25.223Z",
    afterJson: JSON.stringify({ id: "gpt-6.1-sol", name: "gpt-6.1-sol" }),
  });
  // The clock a debut is late against: our own first sighting of the model, under its own name.
  expect(launchSightedAt(db, "gpt-6.1-sol-max")).toBe("2026-09-29T17:13:25.223Z");
  expect(followsAnOldLaunch(db, debut("code/overall", 3, CODE_DEBUT))).toBe(false);
  expect(followsAnOldLaunch(db, debut("code/overall", 3, VISION_DEBUT))).toBe(true);
  db.close();
});

test("first place is never late: the top of a board changing hands is news on its own day", () => {
  const db = openDatabase(":memory:");
  anEvent(db, {
    source: "openai",
    stream: "api-models",
    entityId: "gpt-6.1-sol",
    detectedAt: "2026-09-29T17:13:25.223Z",
    afterJson: JSON.stringify({ id: "gpt-6.1-sol", name: "gpt-6.1-sol" }),
  });
  // Seventy-one hours after the launch, which silences a tenth place and says nothing about a first.
  expect(followsAnOldLaunch(db, debut("code/overall", 1, VISION_DEBUT))).toBe(false);
  expect(followsAnOldLaunch(db, debut("code/overall", 2, VISION_DEBUT))).toBe(true);
  db.close();
});

test("a model no catalogue has carried has no clock to be late against", () => {
  const db = openDatabase(":memory:");
  // Gemini 4 Argon reached the coding board before any catalogue listed it.
  const argon = {
    ...debut("code/overall", 8, "2026-09-30T20:19:53.728Z"),
    after_json: JSON.stringify({
      id: "code:overall:gemini-4-argon-high",
      name: "gemini-4-argon-high",
      category: "code/overall",
      rank: 8,
    }),
  } as Event;
  expect(followsAnOldLaunch(db, argon)).toBe(false);
  db.close();
});

test("the window is two days, because a first debut is slower than a day", () => {
  const db = openDatabase(":memory:");
  anEvent(db, {
    source: "openai",
    stream: "api-models",
    entityId: "grok-4.7",
    detectedAt: "2026-09-20T12:00:00.000Z",
    afterJson: JSON.stringify({ id: "grok-4.7", name: "grok-4.7" }),
  });
  const placing = (detectedAt: string) =>
    ({
      ...debut("code/overall", 10, detectedAt),
      after_json: JSON.stringify({
        id: "code:overall:grok-4.7-xhigh",
        name: "grok-4.7-xhigh",
        category: "code/overall",
        rank: 10,
      }),
    }) as Event;
  // grok-4.7-xhigh took #10 twenty-seven hours after the launch, and was the first word anyone here
  // had on how good it was. A day was short enough to drop it.
  expect(followsAnOldLaunch(db, placing("2026-09-21T15:42:00.000Z"))).toBe(false);
  // Measured on production, the first placings land by thirty-four hours and the repeats from
  // seventy. Two days is the empty gap between them.
  expect(followsAnOldLaunch(db, placing("2026-09-21T22:00:00.000Z"))).toBe(false);
  expect(followsAnOldLaunch(db, placing("2026-09-22T13:00:00.000Z"))).toBe(true);
  db.close();
});

test("only Arena is on the launch clock; a benchmark measures on its own schedule", () => {
  const db = openDatabase(":memory:");
  anEvent(db, {
    source: "alibaba",
    stream: "api-models",
    entityId: "qwen-audio-3.1-tts-plus",
    detectedAt: "2026-09-20T09:00:00.000Z",
    afterJson: JSON.stringify({ id: "qwen-audio-3.1-tts-plus", name: "Qwen-Audio-3.1-TTS-Plus" }),
  });
  // Twelve days later Artificial Analysis published its reading of the model and the card it made was
  // voted up. The delay is that site's queue, not the news going stale: a benchmark arrival carries a
  // number nobody had, where a second Arena board carries a place in a table already shown.
  const measured = {
    ...debut("artificial-analysis/quality", 2, "2026-10-02T09:00:00.000Z"),
    source: "artificial-analysis",
    after_json: JSON.stringify({
      id: "qwen-audio-3.1-tts-plus",
      name: "Qwen-Audio-3.1-TTS-Plus",
      category: "artificial-analysis/quality",
      rank: 2,
    }),
  } as Event;
  expect(followsAnOldLaunch(db, measured)).toBe(false);
  // The anchor is there either way, so it is the source that spared the card and not a missing clock.
  expect(launchSightedAt(db, "qwen-audio-3.1-tts-plus")).toBe("2026-09-20T09:00:00.000Z");
  // The same lateness on the board this clock was written for is still late.
  const onArena = {
    ...measured,
    source: "arena-leaderboards",
    after_json: JSON.stringify({
      id: "code:overall:qwen-audio-3.1-tts-plus",
      name: "Qwen-Audio-3.1-TTS-Plus",
      category: "code/overall",
      rank: 2,
    }),
  } as Event;
  expect(followsAnOldLaunch(db, onArena)).toBe(true);
  db.close();
});

/**
 * GPT-6.1 Sol on the Artificial Analysis quality board, 2026-09-29, as production read it: one model
 * published as five rows, one per reasoning effort, three of them ranked and all five measured above
 * the floor. Announced a row at a time that is five cards about one launch.
 */
const EFFORTS: { name: string; rank?: number; index: number }[] = [
  { name: "GPT-6.1 Sol (low)", index: 44.1 },
  { name: "GPT-6.1 Sol (medium)", index: 47.9 },
  { name: "GPT-6.1 Sol (high)", rank: 16, index: 50.2 },
  { name: "GPT-6.1 Sol (xhigh)", rank: 13, index: 51.1 },
  { name: "GPT-6.1 Sol (max)", rank: 10, index: 51.8 },
];

test("one model measured at five reasoning efforts is one card, under its best place", () => {
  const db = openDatabase(":memory:");
  const wire: Destination = { id: "signals", platform: "discord", channelId: "1", signals: ["debut", "codename"] };
  const board: Collection = {
    source: "artificial-analysis",
    stream: "leaderboards",
    url: "https://artificialanalysis.ai/",
    raw: [],
    records: [
      {
        id: "incumbent",
        name: "Incumbent",
        category: "artificial-analysis/quality",
        rank: 1,
        score: { artificial_analysis_intelligence_index: 60 },
      },
    ],
  };
  saveCollection(db, board, [wire], "2026-09-29T17:46:00.000Z");
  board.records = [
    ...board.records,
    ...EFFORTS.map((effort) => ({
      id: effort.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name: effort.name,
      category: "artificial-analysis/quality",
      rank: effort.rank,
      score: { artificial_analysis_intelligence_index: effort.index },
    })),
  ];
  saveCollection(db, board, [wire], "2026-09-29T18:46:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-29T18:52:00.000Z"));

  const titles = db
    .query<{ body: string }, []>("SELECT body FROM deliveries")
    .all()
    .flatMap((row) => (JSON.parse(row.body) as { embeds: { title: string }[] }).embeds.map((embed) => embed.title))
    .filter((title) => title.includes("GPT-6.1 Sol"));
  // One card, and the effort that reached the ranked places is the one it is about. The five do not
  // travel together: a place in the leading three is told at once and a row with no place waits for
  // the hourly digest, so they are paced into different batches and a batch-local collapse announced
  // Claude Sonnet 5.5 twice, once per half. The question is asked of the board for that reason.
  expect(titles).toEqual(["🏆 GPT-6.1 Sol (max) debuts at #10"]);
  // The other four are held with the reason, rather than silently dropped.
  const held = db
    .query<{ reason: string; detail: string }, []>(
      "SELECT DISTINCT reason, detail FROM suppressions WHERE reason='another_effort_of_the_same_debut'",
    )
    .all();
  expect(held).toEqual([
    {
      reason: "another_effort_of_the_same_debut",
      detail: "The same model measured at another reasoning effort, told under its best one",
    },
  ]);
  db.close();
});

test("an effort level that straggles in days later is not a second card for the same model", () => {
  const db = openDatabase(":memory:");
  const wire: Destination = { id: "signals", platform: "discord", channelId: "1", signals: ["debut", "codename"] };
  const quality = (name: string, index: number, rank?: number) => ({
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name,
    category: "artificial-analysis/quality",
    rank,
    score: { artificial_analysis_intelligence_index: index },
  });
  const board: Collection = {
    source: "artificial-analysis",
    stream: "leaderboards",
    url: "https://artificialanalysis.ai/",
    raw: [],
    records: [quality("Incumbent", 60, 1)],
  };
  saveCollection(db, board, [wire], "2026-09-21T15:44:00.000Z");
  // Grok 4.7, measured at two efforts on 2026-09-21: one card, under the better place.
  board.records = [...board.records, quality("Grok 4.7 (high)", 46.3, 17), quality("Grok 4.7 (xhigh)", 46.4, 16)];
  saveCollection(db, board, [wire], "2026-09-21T16:44:00.000Z");
  // And the Low setting, published ten days later. The reader was told on the twenty-first how good
  // Grok 4.7 is; a weaker setting of it scoring less is not the news a second time.
  board.records = [...board.records, quality("Grok 4.7 (Low)", 41.2)];
  saveCollection(db, board, [wire], "2026-10-01T22:03:00.000Z");
  prepareDeliveries(db, Date.parse("2026-10-01T22:09:00.000Z"));

  const titles = db
    .query<{ body: string }, []>("SELECT body FROM deliveries")
    .all()
    .flatMap((row) => (JSON.parse(row.body) as { embeds: { title: string }[] }).embeds.map((embed) => embed.title))
    .filter((title) => title.includes("Grok 4.7"));
  // Outside the ranked ten the card leads on the number rather than the place, which is the number
  // that earned it: `ANNOUNCED_INDEX` is why this arrival is being told at all.
  expect(titles).toEqual(["🧠 Grok 4.7 (xhigh) enters at 46.4 on the Intelligence Index"]);
  // A different model whose name merely starts the same way is not a sibling of it.
  board.records = [...board.records, quality("Grok 4.75", 44.0)];
  saveCollection(db, board, [wire], "2026-10-02T10:00:00.000Z");
  expect(
    db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM events WHERE kind='new' AND json_extract(after_json,'$.name')='Grok 4.75' AND speaks=1",
      )
      .get()?.n,
  ).toBe(1);
  db.close();
});
