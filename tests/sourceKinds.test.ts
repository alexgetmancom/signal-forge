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
 *
 * 163 on the day kinds were introduced; 160 once the documentation probes became a kind, which is
 * what adding a fourth probe cost -- the budget is what made adding one name the other three.
 *
 * 93 once the five largest families were named: open-weights accounts, maker APIs, reseller
 * catalogues, package registries, retirement schedules and status pages. Nothing about a source
 * changed in that move -- every scheduled and stored field of all 201 was compared before and after
 * -- which is the only reason it could be one commit.
 *
 * 55 once the GitHub group became two kinds rather than one family of 38. The split is by who owns
 * the repository being read, which is the only thing that made those 38 look alike from outside and
 * the whole difference between them from inside: `watched-repository` is somebody else's and
 * `vendor-repository` is the maker's own. The same before-and-after comparison held.
 */
const UNNAMED_BUDGET = 55;

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

/**
 * The kind a repository lands in is decided by who owns it, not by what is read from it. A vendor's
 * repository and a stranger's were one family precisely because pulls, commits and releases are read
 * the same way from both; the owner is what a reader of the report needs back.
 */
test("a repository is a kind by its owner, and its talk is watched whoever owns it", () => {
  const base = loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname });
  const config = {
    ...base,
    github: [
      { repo: "deepseek-ai/DeepSeek-V4", paths: ["README.md"] },
      { repo: "somebody/else", paths: ["README.md"] },
    ],
  };
  const kinds = new Map(buildSourceRegistry(openDatabase(":memory:"), config).map((d) => [d.id, d.kind]));
  expect(kinds.get("github:deepseek-ai/DeepSeek-V4:commits")).toBe("vendor-repository");
  expect(kinds.get("github:somebody/else:commits")).toBe("watched-repository");
  // A maker's own client: the model list is the vendor's, the issues under it are everybody's.
  expect(kinds.get("github:openai/codex:models")).toBe("vendor-repository");
  expect(kinds.get("github:openai/codex:talk")).toBe("watched-repository");
});
