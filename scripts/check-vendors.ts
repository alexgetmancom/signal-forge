/**
 * Every laboratory this repository has decided to collect from is a laboratory it can name.
 *
 * `vendorOfName` answers Unknown for anything no pattern in `src/events/vendors.ts` matches, and
 * Unknown is not cosmetic: the model carries no maker on its card, joins no vendor's story, sorts
 * behind everything in the weekly recap, and since 2026-10-04 is not even read out of OpenCode's
 * catalogue. The table is edited by hand, so it falls behind by construction, and the way that was
 * noticed was a person missing Gemma in a Sunday digest and, a week later, a person reading a diff
 * and seeing `ai21` listed as a Model Garden publisher in the same release that started dropping
 * labs the table does not know.
 *
 * `unknown-makers` already ranks the handles the catalogues brought back, and it needs the running
 * service and a month of events. This asks the half that needs neither: the repository names
 * publishers and vendors in its own source files, by hand, and every one of those names is a
 * decision that this is a laboratory worth reading. A name we chose to read and cannot place is a
 * contradiction inside one commit, which is the kind of thing a gate is for and a reader of a diff
 * is not.
 *
 * Two lists, both derived rather than listed here. `MODEL_GARDEN_PUBLISHERS` is the publishers Vertex
 * is asked for by name. The `vendor:` fields across `src/sources` are who each source is read as
 * speaking for. RECORDED is for the leftover, and a line in it is a sentence saying why a name we
 * read for is not a maker we attribute to -- it is checked in both directions, so a name that has
 * since gained a pattern fails while its line is still there.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { vendorOfName } from "../src/events/vendors.js";
import { MODEL_GARDEN_PUBLISHERS } from "../src/sources/vertex.js";

/**
 * A name this repository reads for that `vendorOfName` does not place, and why that is right.
 *
 * Most of these are venues rather than makers: a source's `vendor` is who it speaks for, and for a
 * gateway that is the gateway. Attributing a model to its host is the mistake the whole ordering of
 * `VENDORS` exists to avoid -- an Anthropic model on Bedrock is Anthropic's news.
 */
const RECORDED: Readonly<Record<string, string>> = {
  // Venues. They host other people's models and make none of their own, so a pattern for them could
  // only ever take a maker's news away from the maker.
  Cerebras: "An inference host; the models it serves are Meta's, Qwen's and OpenAI's.",
  Cursor: "An editor. Composer is theirs, and no catalogue has listed it under a handle yet.",
  DeepInfra: "An inference host, and one of the operators `unknown-makers` counts as one family.",
  "Hugging Face": "The registry every other maker publishes to.",
  // Makers whose models this deployment does not follow, where a pattern would cost more than the
  // silence. Measured 2026-10-04 before writing this down.
  Suno: "Music. Nothing downstream routes audio generation, and `suno` is also an ordinary handle.",
  ai21:
    "Listed for Vertex because Model Garden publishes it, and left unplaced on purpose: AI21 produced " +
    "about one event in ninety days here, and `vendorOfName` is also what OpenCode's reader filters " +
    "on, so a pattern for it reopens 25 catalogue rows into cards nobody asked for. The asymmetry is " +
    "real and this is the cheaper side of it; `unknown-makers` is where it changes if the rate does.",
};

const root = resolve(import.meta.dir, "..");

function walk(directory: string, result: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, result);
    else if (entry.isFile() && entry.name.endsWith(".ts")) result.push(path);
  }
  return result;
}

/** Who each source is read as speaking for, with the file that says so, taken from the text. */
function declaredVendors(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of walk(join(root, "src", "sources")))
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (/^\s*(\*|\/\/)/.test(line)) continue;
      const vendor = /\bvendor:\s*"([^"]+)"/.exec(line)?.[1];
      if (vendor && !found.has(vendor)) found.set(vendor, relative(root, file));
    }
  return found;
}

const named = new Map<string, string>([
  ...MODEL_GARDEN_PUBLISHERS.map((publisher): [string, string] => [publisher, "src/sources/vertex.ts"]),
  ...declaredVendors(),
]);

const unplaced = [...named].filter(([name]) => vendorOfName(name) === "Unknown");
const findings = unplaced
  .filter(([name]) => !(name in RECORDED))
  .map(([name, where]) => `${name} (${where}) is read for and no pattern in src/events/vendors.ts places it`);

// Checked in both directions: a record that is never pruned stops being a record of anything.
const stale = Object.keys(RECORDED).filter((name) => !unplaced.some(([unknown]) => unknown === name));
for (const name of stale)
  findings.push(
    `${name} is recorded as unplaceable in scripts/check-vendors.ts and is either placed now or no longer read for`,
  );

console.log(
  `check-vendors: ${named.size} names read for, ${unplaced.length} unplaced, ${Object.keys(RECORDED).length} recorded`,
);
if (findings.length) {
  for (const finding of findings) console.error(`  ${finding}`);
  console.error("Add a pattern to VENDORS, or a line to RECORDED saying why this name is not a maker.");
  process.exit(1);
}
