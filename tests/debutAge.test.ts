import { expect, test } from "bun:test";
import { isUnannouncedBoard } from "../src/events/boardSignals.js";
import { followsAnOldLaunch, launchNames, launchSightedAt } from "../src/events/debutAge.js";
import { notificationBlock } from "../src/events/notification.js";
import type { Event } from "../src/events/types.js";
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

test("a debut within a day of the launch is told, and the same model's later board is not", () => {
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
