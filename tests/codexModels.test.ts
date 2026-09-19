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
  expect(signalClass(event("new", null, record ?? {}))).toBe("codename");
  expect(signalClass(event("changed", record ?? {}, { ...record, visibility: "list" }))).toBe("codename");
  expect(signalClass(event("changed", record ?? {}, { ...record, context: 400000 }))).toBe("evidence");
});
