import { expect, test } from "bun:test";
import { incidentIsUrgent, incidentSilence } from "../src/events/incidents.js";
import type { Event } from "../src/events/types.js";

const incident = (
  kind: Event["kind"],
  impact: string,
  was: string | null,
  now: string | null,
  name = "OpenAI: Elevated errors",
): Event =>
  ({
    id: 1,
    source: "status:openai",
    stream: "incidents",
    entity_id: "abc",
    kind,
    detected_at: "2026-09-11T10:00:00.000Z",
    before_json: was === null ? null : JSON.stringify({ name, impact, stage: was }),
    after_json: now === null ? null : JSON.stringify({ name, impact, stage: now }),
  }) as Event;

test("an outage the vendor calls severe interrupts the reader", () => {
  const event = incident("new", "major", null, "identified", "Anthropic: Claude Code is unavailable");
  expect(incidentSilence(event)).toBeNull();
  expect(incidentIsUrgent(event)).toBe(true);
});

test("a minor incident is worth its start and its end, and nothing in between", () => {
  expect(incidentSilence(incident("new", "minor", null, "investigating"))).toBeNull();
  expect(incidentSilence(incident("changed", "minor", "monitoring", "resolved"))).toBeNull();
  expect(incidentSilence(incident("changed", "minor", "investigating", "identified"))).toBe(
    "A minor incident moved between working stages",
  );
});

test("an edited sentence on an open incident is not news", () => {
  expect(incidentSilence(incident("changed", "minor", "investigating", "investigating"))).toBe(
    "The incident wording changed but its stage did not",
  );
});

test("what the vendor rates as no impact at all never reaches a reader", () => {
  // "Delays in customer support responses" was posted, then edited four times.
  const event = incident("new", "none", null, "investigating", "OpenAI: Delays in customer support responses");
  expect(incidentSilence(event)).toBe('The vendor rated this "none"');
  expect(incidentIsUrgent(event)).toBe(false);
});

test("a minor incident waits for the digest; a severe one does not", () => {
  expect(incidentIsUrgent(incident("new", "minor", null, "investigating"))).toBe(false);
  expect(incidentIsUrgent(incident("changed", "critical", "identified", "monitoring"))).toBe(true);
});
