import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { sourceKinds } from "../src/reports/sourceKinds.js";
import { buildSourceRegistry } from "../src/sources/registry.js";
import { VENDOR_NAMES } from "../src/sources/vendors.js";
import { openDatabase } from "../src/storage/database.js";

function registry() {
  return buildSourceRegistry(
    openDatabase(":memory:"),
    loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname }),
  );
}

/**
 * How many registered sources belong to no kind, on the day kinds were introduced.
 *
 * A ratchet rather than a rule: two hundred sources exist and thirty-seven of them were converted,
 * so a gate demanding the rest would have to be switched off to pass, and a switched-off gate is
 * worse than none. This may only ever go down. Lower it when a family is named; the failure message
 * says which family is the biggest one left.
 */
const UNNAMED_BUDGET = 163;

test("a source names the maker it belongs to the way the registry spells it", () => {
  const spellings = new Set<string>(VENDOR_NAMES);
  const unknown = [
    ...new Set(registry().flatMap((definition) => (definition.vendor ? [definition.vendor] : []))),
  ].filter((vendor) => !spellings.has(vendor));
  // A free string repeated two hundred times is a spelling waiting to drift, and one maker spelled
  // two ways groups as two makers without anything saying so.
  expect(unknown).toEqual([]);
});

test("no two sources are registered under one id", () => {
  const ids = registry().map((definition) => definition.id);
  expect(ids.length).toBe(new Set(ids).size);
});

test("the sources belonging to no kind only ever get fewer", () => {
  const report = sourceKinds(
    openDatabase(":memory:"),
    loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname }),
  );
  const biggest = report.unnamedFamilies[0];
  expect(
    report.unnamed,
    `${report.unnamed} sources belong to no kind, and the budget is ${UNNAMED_BUDGET}. ` +
      `The largest family nobody has named is ${biggest?.sources} sources in ` +
      `${biggest?.group}/${biggest?.stream} (${biggest?.examples.join(", ")}): give it a kind in ` +
      `src/sources/kinds.ts and lower the budget. \`source-kinds\` is the whole list.`,
  ).toBeLessThanOrEqual(UNNAMED_BUDGET);
});
