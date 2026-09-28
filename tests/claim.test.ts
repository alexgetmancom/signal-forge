import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { claimType } from "../src/events/claim.js";
import { signalClass } from "../src/events/signals.js";
import type { Event, EvidenceType, RecordData } from "../src/events/types.js";
import { buildSourceRegistry } from "../src/sources/registry.js";
import { openDatabase } from "../src/storage/database.js";

/**
 * The evidence type each source declares, which is what the poller stores on every event of it.
 * Read from the registry rather than written out here: a claim is read from the stored row, so a
 * test that invents an evidence type would be asserting against a source contract nobody keeps.
 */
const declared = new Map(
  buildSourceRegistry(
    openDatabase(":memory:"),
    loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname }),
  ).map((source) => [source.id, source.evidence as EvidenceType]),
);

const event = (
  overrides: Partial<Event> & { stream: Event["stream"]; kind: Event["kind"] },
  record: RecordData | null = null,
): Event => ({
  signal: null,
  id: 1,
  source: "openrouter",
  entity_id: "model",
  before_json: null,
  after_json: record ? JSON.stringify(record) : JSON.stringify({ name: "Model" }),
  detected_at: "2026-09-11T00:00:00.000Z",
  evidence_type: declared.get(overrides.source ?? "openrouter") ?? "unknown",
  ...overrides,
});

test("the routing class and the claim answer different questions about the same event", () => {
  // Four events a reader wants at once, which is why they share a route, and which say four
  // different things happened. Grouping a report by the route called all four a launch.
  const listing = event({ stream: "api-models", kind: "new", source: "openai", authority: "first_party" });
  const reset = event({ stream: "resets", kind: "new", source: "codex-limits" });
  const outage = event({ stream: "incidents", kind: "new", source: "status:openai" });
  expect(signalClass(listing)).toBe("launch");
  expect(signalClass(reset)).toBe("launch");
  expect(claimType(listing)).toBe("model_available");
  expect(claimType(reset)).toBe("limit_reset");
  expect(claimType(outage)).toBe("incident_started");
  expect(claimType(event({ stream: "incidents", kind: "removed", source: "status:openai" }))).toBe("incident_resolved");
});

test("a claim is read from the row, so it answers for events recorded before the class was kept", () => {
  // `signal` is NULL on the 8504 events before 2026-09-21 and `signalOf` can only re-derive it.
  const old = event({ stream: "weights", kind: "new", source: "huggingface:openai", signal: null });
  expect(claimType(old)).toBe("weights_published");
});

test("a reseller listing a model and a maker publishing one are not the same claim", () => {
  expect(claimType(event({ stream: "openrouter", kind: "new", source: "openrouter" }))).toBe("model_listed");
  expect(claimType(event({ stream: "api-models", kind: "new", source: "openai", authority: "first_party" }))).toBe(
    "model_available",
  );
  // A name leaving a catalogue claims the opposite of the one that put it there.
  expect(claimType(event({ stream: "openrouter", kind: "removed", source: "openrouter" }))).toBe("model_delisted");
});

test("a row whose only moved field is its price sheet says the price moved, not that a model arrived", () => {
  const priced = event(
    {
      stream: "openrouter",
      kind: "changed",
      source: "openrouter",
      before_json: JSON.stringify({ id: "m", name: "M", pricing: { prompt: "1" } }),
    },
    { id: "m", name: "M", pricing: { prompt: "2" } },
  );
  expect(claimType(priced)).toBe("price_changed");
  // A field beside the price moving is a listing changing, which is not a price claim.
  const renamed = event(
    {
      stream: "openrouter",
      kind: "changed",
      source: "openrouter",
      before_json: JSON.stringify({ id: "m", name: "M", pricing: { prompt: "1" } }),
    },
    { id: "m", name: "M Turbo", pricing: { prompt: "2" } },
  );
  expect(claimType(renamed)).toBe("model_listed");
});

test("software published around the models is software, and a repository naming a model is a sighting", () => {
  expect(claimType(event({ stream: "packages", kind: "new", source: "npm:@openai/codex" }))).toBe("software_released");
  expect(claimType(event({ stream: "github", kind: "new", source: "github:openai/codex:commits" }))).toBe(
    "repository_activity",
  );
  expect(claimType(event({ stream: "github", kind: "new", source: "github:openai/codex:models" }))).toBe(
    "model_sighted",
  );
});

test("a market claims nothing about the world, so it claims nothing here", () => {
  // It says what strangers expect to happen, which is the reason the stream sits at the confidence
  // floor as well. A report counting claims must not count a bet as one.
  expect(claimType(event({ stream: "markets", kind: "new", source: "polymarket" }))).toBeNull();
});
