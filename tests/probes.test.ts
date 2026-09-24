import { expect, test } from "bun:test";
import { bundleModelIds, CLI_BUNDLES } from "../src/sources/cliBundles.js";
import { collectDocsProbe, collectOpenCodeData, PROBE_SITES } from "../src/sources/probes.js";

function answering(pages: Record<string, string>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const body = pages[url];
    return new Response(body ?? "Page not found", { status: body === undefined ? 404 : 200 });
  }) as unknown as typeof fetch;
}

const anthropic = PROBE_SITES.find((site) => site.id === "discovery:docs-anthropic");

test("a documentation page that exists for an unannounced model is a sighting", async () => {
  if (!anthropic) throw new Error("the Anthropic probe is gone");
  const collection = await collectDocsProbe(
    anthropic,
    answering({
      "https://platform.claude.com/docs/en/models/opus-5-5/overview": "the model we ship",
      "https://platform.claude.com/docs/en/models/opus-6/overview": "the model we have not announced",
    }),
  );
  expect(collection.records.map((record) => record.id)).toEqual(["opus-6"]);
  expect(collection.source).toBe("discovery:docs-anthropic");
  expect(collection.appendOnly).toBe(true);
});

test("a probe whose control has moved is a failure, not an empty answer", async () => {
  if (!anthropic) throw new Error("the Anthropic probe is gone");
  await expect(collectDocsProbe(anthropic, answering({}))).rejects.toThrow("opus-5-5 answered HTTP 404");
});

test("OpenCode answers for every name and only a real page counts", async () => {
  const real = "Completed sessions ... Token Share";
  const collection = await collectOpenCodeData(
    answering({
      "https://opencode.ai/data/unknown/space-bunny": real,
      "https://opencode.ai/data/unknown/sonoma-sky": "Models ... breadcrumb only",
    }),
  );
  expect(collection.records.map((record) => record.id)).toEqual(["unknown/space-bunny"]);
});

test("a client's bundle names its models and not its fixtures", () => {
  const gemini = CLI_BUNDLES.find((bundle) => bundle.source === "gemini-cli-models");
  if (!gemini) throw new Error("the Gemini CLI bundle is gone");
  const text = '"gemini-3.8-flash" "gemini-9001-super-duper" "gemini-3-flash-base" "gemini-3.1-pro-preview"';
  expect(bundleModelIds(text, gemini.pattern)).toEqual(["gemini-3.1-pro-preview", "gemini-3.8-flash"]);
});

test("a dated alias is the model it dates, not a second one", () => {
  const qwen = CLI_BUNDLES.find((bundle) => bundle.source === "qwen-code-models");
  if (!qwen) throw new Error("the Qwen Code bundle is gone");
  expect(bundleModelIds('"qwen3.8-max" "qwen3.8-max-0902" "qwen3-max-2026-01-23"', qwen.pattern)).toEqual([
    "qwen3.8-max",
  ]);
});
