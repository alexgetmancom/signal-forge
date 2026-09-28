import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { buildSourceRegistry } from "../src/sources/registry.js";
import { openDatabase } from "../src/storage/database.js";

function registry() {
  return buildSourceRegistry(
    openDatabase(":memory:"),
    loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname }),
  );
}

const COLLECTORS = new URL("../src/sources/", import.meta.url).pathname;

/**
 * Whether an omission is a withdrawal is a static fact about the surface, so it is declared in the
 * registry and spread onto the collection by the poller. Nothing stops a collector setting it
 * again -- `Collection` still carries the field, because `saveCollection` reads it and because a
 * fixture builds a collection with no registry behind it -- and a collector that did would be
 * declaring in two places the thing this moved into one. The compiler cannot see that, so this can.
 */
test("no collector declares appendOnly for itself", () => {
  const offenders = readdirSync(COLLECTORS, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts") && !entry.startsWith("packs/"))
    .filter((entry) => !["definition.ts", "kinds.ts", "registry.ts"].includes(entry))
    .filter((entry) => readFileSync(join(COLLECTORS, entry), "utf8").includes("appendOnly"));
  expect(offenders).toEqual([]);
});

/**
 * A feed and a catalogue, one of each, by name. The registry is where the fact lives now, and a
 * move that quietly dropped it everywhere would leave every report agreeing and every answer wrong.
 */
test("the registry says which sources are append-only", () => {
  const byId = new Map(registry().map((definition) => [definition.id, definition.appendOnly === true]));
  // The sources whose own parser tests used to make this claim, each now made once, here.
  for (const id of [
    "anthropic-news",
    "claude-blog",
    "hackernews",
    "deepseek-updates",
    "openai-chatgpt-release-notes",
    "openai-api-changelog",
    "kimi-code-changelog",
    "minimax-code-changelog",
    "huggingface:openai",
    "huggingface:deepseek-ai",
    "openrouter-usage",
    "codex-resets",
    "openai-deprecations",
    "discovery:huggingface-trending",
    "discovery:github-ai",
    "discovery:docs-anthropic",
    "status:openai",
  ])
    expect([id, byId.get(id)]).toEqual([id, true]);
  // A catalogue: an id it stops naming is the vendor withdrawing the model.
  expect(byId.get("deepseek-api")).toBe(false);
  expect(byId.get("openrouter")).toBe(false);
  expect([...byId.values()].filter(Boolean).length).toBeGreaterThan(50);
});
