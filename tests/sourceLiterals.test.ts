import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { buildSourceRegistry } from "../src/sources/registry.js";
import { openDatabase } from "../src/storage/database.js";

/**
 * Every source a routing rule names by hand is a source that exists.
 *
 * The rules in src/events/ decide what a reader hears, and twenty of them do it by comparing
 * `event.source` against a string literal. A literal is invisible to every other kind of checking
 * here: the registry can drop a source, an organisation can be renamed upstream, a prefix can be
 * respelled, and the rule that mentioned it keeps compiling and silently stops applying. A rule
 * that stopped applying and a rule that was never needed look identical from the outside, and the
 * first one is a card going out that should not.
 *
 * What this cannot do is the thing that actually went wrong on 2026-10-04, and it is worth being
 * clear about: `huggingface:` matched `huggingface:microsoft` perfectly, and the rule still missed
 * it, because the rule was scoped to one surface of a question that belonged to all of them. No
 * check over names can find that -- `published_long_before_we_read_it` fixed it by asking the
 * question of a stream rather than of a source. This guards the other half: the names that are
 * still named stay real.
 */
function sourceIds(): string[] {
  return buildSourceRegistry(
    openDatabase(":memory:"),
    loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname }),
  ).map((definition) => definition.id);
}

/** `event.source === "x"`, `!== "x"` and `.startsWith("x")`, which is every shape in use. */
function sourceLiterals(): { file: string; literal: string; exact: boolean }[] {
  const found: { file: string; literal: string; exact: boolean }[] = [];
  for (const file of readdirSync("src/events").filter((name) => name.endsWith(".ts"))) {
    const text = readFileSync(`src/events/${file}`, "utf8");
    for (const match of text.matchAll(/(?:event|e)\.source\s*(===|!==)\s*"([^"]+)"/g))
      found.push({ file, literal: match[2] ?? "", exact: true });
    for (const match of text.matchAll(/(?:event|e)\.source\.startsWith\("([^"]+)"\)/g))
      found.push({ file, literal: match[1] ?? "", exact: false });
  }
  return found;
}

test("every source a routing rule names by hand is one the registry builds", () => {
  const ids = sourceIds();
  const literals = sourceLiterals();
  // A guard that matched nothing would pass for ever; the rules do name sources, and if they stop
  // naming any, this test is the thing to delete rather than the thing to keep passing.
  expect(literals.length).toBeGreaterThan(5);
  const unmatched = literals.filter(({ literal, exact }) =>
    exact ? !ids.includes(literal) : !ids.some((id) => id.startsWith(literal)),
  );
  expect(unmatched).toEqual([]);
});
