import { expect, test } from "bun:test";
import { signalClass } from "../src/events/signals.js";
import type { Event } from "../src/events/types.js";
import { parseCodexModels } from "../src/sources/codex.js";

const file = JSON.stringify({
  models: [
    {
      slug: "gpt-daybreak-blue-latest",
      display_name: "Daybreak Blue",
      visibility: "hide",
      available_in_plans: ["pro"],
      context_window: 272000,
      max_context_window: 872000,
      supported_reasoning_levels: [
        { effort: "high", description: "Greater reasoning depth for complex problems" },
        { effort: "low", description: "Fast responses with lighter reasoning" },
        { effort: "ultra", description: "Maximum reasoning with automatic task delegation" },
      ],
      supports_reasoning_effort_updates: true,
      base_instructions: "long",
    },
  ],
});
const event = (kind: string, before: object | null, after: object): Event =>
  ({
    id: 1,
    source: "codex-models",
    stream: "github",
    entity_id: "gpt-daybreak-blue-latest",
    kind,
    before_json: before ? JSON.stringify(before) : null,
    after_json: JSON.stringify(after),
    detected_at: "2026-09-19T00:00:00.000Z",
    snapshot_id: 1,
  }) as unknown as Event;

test("a slug new to the Codex model list is a sighting, and so is one opening up; a prompt edit is not", () => {
  const [record] = parseCodexModels(file).records;
  expect(record).toMatchObject({ id: "gpt-daybreak-blue-latest", name: "Daybreak Blue", visibility: "hide" });
  expect(record).not.toHaveProperty("base_instructions");
  // What a session is given and what the model can hold are two numbers, and both are kept.
  expect(record).toMatchObject({ context: 272000, maxContext: 872000, reasoningUpdates: true });
  // The efforts by name only: the sentence beside each one is interface copy that gets reworded.
  expect(record?.reasoning).toEqual(["high", "low", "ultra"]);
  expect(JSON.stringify(record)).not.toContain("Fast responses");
  expect(signalClass(event("new", null, record ?? {}))).toBe("codename");
  expect(signalClass(event("changed", record ?? {}, { ...record, visibility: "list" }))).toBe("codename");
  expect(signalClass(event("changed", record ?? {}, { ...record, context: 400000 }))).toBe("evidence");
});
