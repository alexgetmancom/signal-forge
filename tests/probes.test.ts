import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { bundleModelIds, CLI_BUNDLES } from "../src/sources/cliBundles.js";
import { APT_REPOSITORIES, collectAptRepository, collectClaudeDownloads } from "../src/sources/desktop.js";
import { collectDocsProbe, collectOpenCodeData, observedFamilies, PROBE_SITES } from "../src/sources/probes.js";
import { openDatabase } from "../src/storage/database.js";

function answering(pages: Record<string, string>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const body = pages[url];
    return new Response(body ?? "Page not found", { status: body === undefined ? 404 : 200 });
  }) as unknown as typeof fetch;
}

const anthropic = PROBE_SITES.find((site) => site.id === "discovery:docs-anthropic");

/** A catalogue that has heard of the models named, and of nothing newer. */
function catalogue(ids: readonly string[]): Database {
  const db = openDatabase(":memory:");
  const insert = db.query(
    "INSERT INTO model_facts(canonical_id,first_seen_at,updated_at) VALUES(?,'2026-09-22T00:00:00.000Z','2026-09-22T00:00:00.000Z')",
  );
  for (const id of ids) insert.run(id);
  return db;
}

test("a documentation page that exists for an unannounced model is a sighting", async () => {
  if (!anthropic) throw new Error("the Anthropic probe is gone");
  const collection = await collectDocsProbe(
    catalogue(["claude-opus-5-5", "claude-opus-5-5-fast"]),
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
  await expect(collectDocsProbe(catalogue(["claude-opus-5-5"]), anthropic, answering({}))).rejects.toThrow(
    "opus-5-5 answered HTTP 404",
  );
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

test("an Anthropic download manifest that answers is a product, and the rest are 404s", async () => {
  const collection = await collectClaudeDownloads(
    answering({
      "https://downloads.claude.ai/claude-science/latest/manifest.json": JSON.stringify({
        version: "0.1.52",
        buildDate: "2026-09-22T23:17:30Z",
      }),
      "https://downloads.claude.ai/claude-cowork/latest/manifest.json": JSON.stringify({ version: "0.0.1" }),
    }),
  );
  expect(collection.records.map((record) => record.id)).toEqual(["claude-science", "claude-cowork"]);
  expect(collection.records[0]).toMatchObject({ version: "0.1.52", maker: "Anthropic" });
});

test("a download page that answers nothing at all is a failure, not an empty catalogue", async () => {
  await expect(collectClaudeDownloads(answering({}))).rejects.toThrow("not even Claude Science");
});

test("a Debian index is read for the newest build of the client", async () => {
  const claude = APT_REPOSITORIES.find((repository) => repository.source === "claude-desktop-apt");
  if (!claude) throw new Error("the Claude Desktop repository is gone");
  const index = [
    "Package: claude-desktop\nVersion: 2.2553.13\nSize: 173779072",
    "Package: claude-desktop\nVersion: 2.7032.0\nSize: 174864804",
    "Package: something-else\nVersion: 9.9.9\nSize: 1",
  ].join("\n\n");
  const collection = await collectAptRepository(
    claude,
    answering({
      "https://downloads.claude.ai/claude-desktop/apt/stable/dists/stable/main/binary-amd64/Packages": index,
    }),
  );
  expect(collection.records[0]).toMatchObject({ version: "2.7032.0", versions: 2, bytes: 174864804 });
});

test("an index that stops naming the package is a failure, not a release", async () => {
  const chatgpt = APT_REPOSITORIES.find((repository) => repository.source === "chatgpt-desktop-apt");
  if (!chatgpt) throw new Error("the ChatGPT repository is gone");
  await expect(
    collectAptRepository(
      chatgpt,
      answering({
        "https://persistent.oaistatic.com/codex-app-prod/linux/deb/dists/stable/main/binary-amd64/Packages":
          "Package: gnome-calculator\nVersion: 1.0\n",
      }),
    ),
  ).rejects.toThrow("names no chatgpt");
});

test("the questions follow the catalogue: what is out is never asked for again", async () => {
  const openai = PROBE_SITES.find((site) => site.id === "discovery:docs-openai");
  if (!openai) throw new Error("the OpenAI probe is gone");
  const asked: string[] = [];
  const watching = (async (input: string | URL) => {
    asked.push(String(input).split("/").at(-1) ?? "");
    return new Response("a page", { status: String(input).endsWith("gpt-6-sol") ? 200 : 404 });
  }) as unknown as typeof fetch;
  await collectDocsProbe(catalogue(["gpt-6-sol", "gpt-6-astra", "gpt-5.6-cyber"]), openai, watching);
  // Six is out, so the probe asks past it and never for it.
  expect(asked).toContain("gpt-6.1");
  expect(asked).toContain("gpt-7");
  expect(asked.filter((slug) => slug === "gpt-6")).toEqual([]);
});

test("the highest version of each shape is the one the catalogue has, under its shortest name", () => {
  const google = PROBE_SITES.find((site) => site.id === "discovery:docs-google");
  if (!google) throw new Error("the Google probe is gone");
  const found = observedFamilies(
    catalogue(["gemini-3.7-flash", "gemini-3.8-flash", "gemini-3.8-flash-image", "gemini-3.5-pro"]),
    google,
  );
  expect(found).toEqual([
    { family: "gemini-#-pro", version: [3, 5], observed: "gemini-3.5-pro" },
    { family: "gemini-#-flash", version: [3, 8], observed: "gemini-3.8-flash" },
  ]);
});

test("a tier behind the rest is asked the questions the furthest tier earns", async () => {
  const google = PROBE_SITES.find((site) => site.id === "discovery:docs-google");
  if (!google) throw new Error("the Google probe is gone");
  const asked: string[] = [];
  const watching = (async (input: string | URL) => {
    asked.push(String(input).split("/").at(-1) ?? "");
    return new Response("a page", { status: String(input).endsWith("gemini-3.8-flash") ? 200 : 404 });
  }) as unknown as typeof fetch;
  await collectDocsProbe(catalogue(["gemini-3.8-flash", "gemini-3.1-pro"]), google, watching);
  // Pro is five minors behind flash, and the next pro is likelier to be the next whole number.
  expect(asked).toContain("gemini-4-pro");
  expect(asked).toContain("gemini-3.9-pro");
  expect(asked).toContain("gemini-3.2-pro");
});

test("a version no maker could be at is a spelling, not a version", () => {
  const openai = PROBE_SITES.find((site) => site.id === "discovery:docs-openai");
  if (!openai) throw new Error("the OpenAI probe is gone");
  // `gpt-56-sol` is `gpt-5.6-sol` with the dot normalised away, and read as 56 it poisons the probe.
  expect(observedFamilies(catalogue(["gpt-56-sol", "gpt-6-sol"]), openai)).toEqual([
    { family: "gpt", version: [6, 0], observed: "gpt-6-sol" },
  ]);
});
