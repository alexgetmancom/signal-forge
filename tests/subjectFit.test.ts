import { expect, test } from "bun:test";
import { isTellableDebut, isUnannouncedBoard } from "../src/events/boardSignals.js";
import { notificationBlock } from "../src/events/notification.js";
import { pageClass } from "../src/events/pageSignals.js";
import { catalogueClass } from "../src/events/resellers.js";
import { signalClass } from "../src/events/signals.js";
import { isAJobThisReaderDidNotComeFor, isAnnouncedBoard } from "../src/events/subject.js";
import type { Event } from "../src/events/types.js";
import { isMinorBoardMove } from "../src/events/worth.js";

/**
 * Eleven v4 Turbo, 2026-10-05, as production saw it: the record is the one the board published,
 * copied from the row it was stored as. It took first place, was classed `debut` and reached both
 * public channels, and nothing suppressed it because nothing had been asked. `prod why` listed
 * twenty-nine standing rules, all of them silent, which is what a decision made where decisions
 * have no names looks like from outside.
 */
const BOARD_RECORD = {
  category: "artificial-analysis/text-to-speech",
  id: "1743efcc-71b5-415c-9a64-f03c739127ef",
  maker: "ElevenLabs",
  modelKey: "eleven-v4-turbo",
  name: "Eleven v4 Turbo",
  rank: 1,
  score: 1334,
};

const boardEvent = (record: object, source = "artificial-analysis:text-to-speech"): Event =>
  ({
    id: 51_816,
    source,
    stream: "leaderboards",
    entity_id: "1743efcc-71b5-415c-9a64-f03c739127ef",
    kind: "new",
    signal: "debut",
    detected_at: "2026-10-05T21:44:29.039Z",
    confidence: "observed",
    after_json: JSON.stringify(record),
    before_json: null,
  }) as unknown as Event;

test("first place on a board about voices is a sighting for the radar, not a card", () => {
  const event = boardEvent(BOARD_RECORD);
  expect(signalClass(event)).toBe("codename");
  // Every gate, because the class and the two delivery gates used to answer this separately: a card
  // classed here and silenced there is the failure `isTellableDebut` exists for.
  expect(isTellableDebut(event)).toBe(false);
  // Routed to the radar rather than silenced: a voice model taking first place is a real sighting
  // and the scouts subscribe to `codename`. Only the news channel was never for it. The Arena gate
  // stays a source rule and does not answer here -- see `isUnannouncedBoard`.
  expect(isUnannouncedBoard(event)).toBe(false);
  expect(isMinorBoardMove(event)).toBe(false);
  expect(notificationBlock(event)).toBeNull();
});

test("the boards this feed announces are a list, so a board nobody has seen yet is a sighting", () => {
  for (const board of ["code/overall", "text/overall", "artificial-analysis/quality"])
    expect(isAnnouncedBoard(board)).toBe(true);
  for (const board of [
    "vision/overall",
    "text-to-image/overall",
    "image-edit/overall",
    "image-to-video/overall",
    "artificial-analysis/text-to-speech",
    "artificial-analysis/image-editing",
    "designarena/website",
    // The next board either site adds, which no list of excluded words would have known about.
    "text-to-3d/overall",
  ])
    expect(isAnnouncedBoard(board)).toBe(false);
  // A row whose record names no board has nothing to be matched against, and the arrival rules
  // answer for it instead of this one.
  expect(isAnnouncedBoard(undefined)).toBe(false);
});

test("a source dedicated to a modality has declared one, whatever the models in it are called", () => {
  // The reading the name alone cannot do: there is no modality word in `eleven-v4-turbo`, and there
  // never will be. The source id carries it.
  expect(isAJobThisReaderDidNotComeFor(boardEvent(BOARD_RECORD), BOARD_RECORD)).toBe(true);
  expect(isAJobThisReaderDidNotComeFor(boardEvent(BOARD_RECORD, "arena-leaderboards"), BOARD_RECORD)).toBe(false);
});

test("one question, asked the same way by the catalogue and the pages", () => {
  const listing = (id: string, name: string): Event =>
    ({
      id: 1,
      source: "gemini",
      stream: "api-models",
      entity_id: id,
      kind: "new",
      detected_at: "2026-09-22T09:00:00.000Z",
      after_json: JSON.stringify({ id, name }),
      before_json: null,
    }) as unknown as Event;
  const record = (id: string, name: string) => ({ id, name });
  // A voice in the maker's own catalogue is still a sighting; a coding model there is the launch.
  expect(catalogueClass(listing("gemini-3.8-tts", "Gemini 3.8 TTS"), record("gemini-3.8-tts", "Gemini 3.8 TTS"))).toBe(
    "codename",
  );
  expect(catalogueClass(listing("gemini-4-argon", "Gemini 4 Argon"), record("gemini-4-argon", "Gemini 4 Argon"))).toBe(
    "launch",
  );
  const page = (path: string): Event =>
    ({
      id: 2,
      source: "pages:google",
      stream: "pages",
      entity_id: path,
      kind: "new",
      detected_at: "2026-09-23T09:00:00.000Z",
      after_json: JSON.stringify({ id: path, name: "Quickstart" }),
      before_json: null,
    }) as unknown as Event;
  // The same word, read out of a path whose separators are not a name's. Google published the
  // Gemini 3.8 TTS models as eight pages on 2026-09-23 and the survivor reached the news channel.
  expect(pageClass(page("/gemini-api/docs/speech/quickstart"))).toBe("evidence");
});
