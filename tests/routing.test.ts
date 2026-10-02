import { expect, test } from "bun:test";
import { onNewBoard, paceOf, readyAt } from "../src/events/routing.js";
import type { Event } from "../src/events/types.js";

const event = (fields: Partial<Event>): Event => ({
  id: 1,
  source: "openrouter",
  stream: "api-models",
  entity_id: "m",
  kind: "changed",
  before_json: null,
  after_json: null,
  detected_at: "2026-10-02T12:00:00.000Z",
  signal: null,
  ...fields,
});

test("an event is told at once, after the stealth hold, or with the next hour's digest", () => {
  const now = "2026-10-02T12:34:56.000Z";
  expect(readyAt("now", now)).toBe(now);
  expect(readyAt("held", now)).toBe("2026-10-02T12:36:56.000Z");
  expect(readyAt("hourly", now)).toBe("2026-10-02T13:00:00.000Z");
  // On the hour itself the digest is the next one: the hour that has begun already has its own.
  expect(readyAt("hourly", "2026-10-02T13:00:00.000Z")).toBe("2026-10-02T14:00:00.000Z");
});

test("a routine change travels with the digest, a stealth launch is held, everything else is told now", () => {
  expect(paceOf(event({ source: "claude-web" }))).toBe("hourly");
  const stealth = event({
    kind: "new",
    entity_id: "stealth/space-bunny-alpha",
    after_json: JSON.stringify({
      id: "stealth/space-bunny-alpha",
      name: "Space Bunny",
      pricing: { prompt: "0", completion: "0" },
    }),
  });
  expect(paceOf(stealth)).toBe("held");
  // The same model with a price on it is a catalogue growing, not a free launch.
  expect(
    paceOf({
      ...stealth,
      after_json: JSON.stringify({ id: "stealth/space-bunny-alpha", name: "Space Bunny", pricing: { prompt: "1" } }),
    }),
  ).toBe("now");
  expect(paceOf(event({ kind: "new", entity_id: "gpt-6" }))).toBe("now");
});

test("a debut on a board nobody had is one fact, not ten debuts", () => {
  const stored = [{ body: JSON.stringify({ id: "a", category: "text" }) }];
  const debut = (category: string) => event({ kind: "new", after_json: JSON.stringify({ id: "b", category }) });
  const onANewBoard = onNewBoard("leaderboards", stored);
  expect(onANewBoard(debut("image-to-code"))).toBe(true);
  expect(onANewBoard(debut("text"))).toBe(false);
  // Only an arrival can be the first of a board.
  expect(onANewBoard(event({ kind: "changed", after_json: JSON.stringify({ category: "image-to-code" }) }))).toBe(
    false,
  );
  // Other streams have no boards to open, and read nothing.
  expect(onNewBoard("api-models", stored)(debut("image-to-code"))).toBe(false);
});
