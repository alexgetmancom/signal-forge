import { expect, test } from "bun:test";
import { rules } from "../src/reports/rules.js";

const config = {
  destinations: [
    { id: "discord-signals", signals: ["launch", "debut"] },
    { id: "discord-scouts", signals: ["codename"] },
  ],
} as never;

test("every layer names its rules, in the order they are asked", () => {
  const map = rules(config);
  expect(map.layers.map((layer) => layer.layer)).toEqual([
    "the event alone",
    "the event and the database",
    "the standing judgement",
    "one event, one destination",
  ]);
  // Generated from the lists the delivery path runs, so a layer with no rules in it means a list
  // was renamed and this report quietly stopped reading it.
  for (const layer of map.layers) expect(layer.rules.length).toBeGreaterThan(0);
  // The two questions whose order was the bug, in the order they are now asked.
  const classRules = map.layers[0]?.rules ?? [];
  expect(classRules).toContain("a_row_in_a_catalogue");
  expect(classRules.indexOf("free_and_unclaimed_at_a_reseller")).toBe(0);
  // Named in one place and only one: a reason with no sentence behind it cannot be shipped, and a
  // sentence with no reason cannot either, because the record is typed by the tuple.
  expect(map.reasons.length).toBeGreaterThan(30);
  for (const { detail } of map.reasons) expect(detail.length).toBeGreaterThan(0);
  expect(map.destinations).toEqual([
    { destination: "discord-signals", signals: ["launch", "debut"] },
    { destination: "discord-scouts", signals: ["codename"] },
  ]);
});
