import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { sourceFamily, sourceIndependenceFamily } from "../src/events/sourceFamily.js";
import { buildSourceRegistry } from "../src/sources/registry.js";
import { openDatabase } from "../src/storage/database.js";

test("source families collapse discovery queries but preserve independent surfaces", () => {
  expect(sourceFamily("discovery:github-ai", "github")).toBe("discovery:github");
  expect(sourceFamily("discovery:github-mcp", "github")).toBe("discovery:github");
  expect(sourceFamily("github:openai/codex:pulls", "github")).toBe("github:openai/codex");
  expect(sourceFamily("github:openai/codex:commits", "github")).toBe("github:openai/codex");
  expect(sourceFamily("huggingface:openai", "weights")).toBe("huggingface");
  expect(sourceFamily("discovery:huggingface-trending", "weights")).toBe("huggingface");
  expect(sourceFamily("openai", "api-models")).toBe("provider-api:openai");
  expect(sourceFamily("vercel-gateway", "api-models")).toBe("provider-api:vercel-gateway");
  expect(sourceFamily("openai-news", "news")).toBe("official-news:openai-news");
  expect(sourceFamily("anthropic-news", "news")).toBe("official-news:anthropic-news");
  expect(sourceFamily("anthropic-deprecations", "deprecations")).toBe("deprecations:anthropic-deprecations");
  expect(sourceFamily("status:openai", "incidents")).toBe("status:openai");
  expect(sourceFamily("new-surface")).toBe("new-surface");
});

test("independent confirmation collapses every surface one vendor answers for", () => {
  const openAi = { authority: "first_party", vendor: "OpenAI" } as const;
  expect(sourceIndependenceFamily({ source: "openai", stream: "api-models", ...openAi })).toBe("vendor:OpenAI");
  expect(sourceIndependenceFamily({ source: "openai-news", stream: "news", ...openAi })).toBe("vendor:OpenAI");
  expect(
    sourceIndependenceFamily({
      source: "app:ios:chatgpt",
      stream: "apps",
      authority: "vendor_owned",
      vendor: "OpenAI",
    }),
  ).toBe("vendor:OpenAI");
  // Moonshot's coding tier is still Moonshot speaking, not a second witness.
  expect(
    sourceIndependenceFamily({ source: "kimi", stream: "api-models", authority: "first_party", vendor: "Moonshot" }),
  ).toBe("vendor:Moonshot");
  expect(
    sourceIndependenceFamily({ source: "openrouter", stream: "openrouter", authority: "third_party", vendor: null }),
  ).toBe("openrouter");
  expect(
    sourceIndependenceFamily({
      source: "huggingface:openai",
      stream: "weights",
      authority: "vendor_owned",
      vendor: null,
    }),
  ).toBe("huggingface");
});

test("a gateway reselling other makers' models never reads as a maker's catalogue", () => {
  const registry = buildSourceRegistry(
    openDatabase(":memory:"),
    loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname }),
  );
  expect(registry.find((definition) => definition.id === "vercel-gateway")?.authority).toBe("third_party");
});
