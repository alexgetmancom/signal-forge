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
    signal: null,
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

test("an incident is worth its start and nothing after it", () => {
  // A reader told the service is broken finds out it is fixed by using it. Being interrupted a
  // second time to hear the outage ended is the interruption without the news.
  expect(incidentSilence(incident("new", "minor", null, "investigating"))).toBeNull();
  expect(incidentSilence(incident("changed", "minor", "monitoring", "resolved"))).toBe(
    "The incident ended, and its start was already reported",
  );
  expect(incidentSilence(incident("changed", "minor", "investigating", "identified"))).toBe(
    "The incident moved between working stages",
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

test("a minor incident waits for the digest; a severe one's start does not", () => {
  expect(incidentIsUrgent(incident("new", "minor", null, "investigating"))).toBe(false);
  expect(incidentIsUrgent(incident("new", "critical", null, "identified"))).toBe(true);
  // An update to an outage already reported is not urgent, however the vendor grades it.
  expect(incidentIsUrgent(incident("changed", "critical", "identified", "monitoring"))).toBe(false);
});

test("a severe incident speaks when it starts and not once more", () => {
  // OpenAI's 01M2KQNE5C42NEZPX6V01NHH5W was graded major, so every Statuspage edit reached the
  // public channel: three messages about one outage inside forty-seven minutes on 2026-09-16.
  const major = (stage: string, next: string) => ({
    signal: null,
    id: 1,
    source: "status:openai",
    stream: "incidents" as const,
    entity_id: "01M2KQNE5C42NEZPX6V01NHH5W",
    kind: "changed" as const,
    before_json: JSON.stringify({ id: "i", name: "Elevated errors", impact: "major", stage }),
    after_json: JSON.stringify({ id: "i", name: "Elevated errors", impact: "major", stage: next }),
    detected_at: "2026-09-16T00:03:45.637Z",
  });
  expect(incidentSilence(major("investigating", "identified"))).toBe("The incident moved between working stages");
  expect(incidentSilence(major("identified", "monitoring"))).toBe("The incident moved between working stages");
  expect(incidentSilence(major("monitoring", "monitoring"))).toBe("The incident wording changed but its stage did not");
  expect(incidentSilence(major("monitoring", "resolved"))).toBe(
    "The incident ended, and its start was already reported",
  );
});
