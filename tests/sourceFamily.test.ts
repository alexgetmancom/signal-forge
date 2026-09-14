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
  expect(sourceFamily("discovery:huggingface-recent", "weights")).toBe("huggingface");
  expect(sourceFamily("openai", "api-models")).toBe("provider-api:openai");
  expect(sourceFamily("vercel-gateway", "api-models")).toBe("provider-api:vercel-gateway");
  expect(sourceFamily("openai-news", "news")).toBe("official-news:openai-news");
  expect(sourceFamily("anthropic-news", "news")).toBe("official-news:anthropic-news");
  expect(sourceFamily("anthropic-deprecations", "deprecations")).toBe("deprecations:anthropic-deprecations");
  expect(sourceFamily("status:openai", "incidents")).toBe("status:openai");
  expect(sourceFamily("new-surface")).toBe("new-surface");
});

test("independent confirmation collapses official surfaces from one vendor", () => {
  expect(sourceIndependenceFamily("openai", "api-models")).toBe("first-party:OpenAI");
  expect(sourceIndependenceFamily("openai-news", "news")).toBe("first-party:OpenAI");
  expect(sourceIndependenceFamily("openai-codex-changelog", "news")).toBe("first-party:OpenAI");
  expect(sourceIndependenceFamily("openai-api-changelog", "news")).toBe("first-party:OpenAI");
  expect(sourceIndependenceFamily("status:openai", "incidents")).toBe("first-party:OpenAI");
  expect(sourceIndependenceFamily("status:deepseek", "incidents")).toBe("first-party:DeepSeek");
  expect(sourceIndependenceFamily("status:moonshot", "incidents")).toBe("first-party:Moonshot");
  expect(sourceIndependenceFamily("openrouter", "openrouter")).toBe("openrouter");
});

/**
 * The vendor map is a second list of something the registry already knows, so it drifts silently:
 * a first-party source missing from it counts as an independent witness to its own vendor's claim.
 */
test("every first-party source collapses to a vendor family", () => {
  const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
  const config = loadConfig({
    CONFIG_PATH: configPath,
    XAI_API_KEY: "k",
    ZAI_API_KEY: "k",
    MOONSHOT_API_KEY: "k",
    MISTRAL_API_KEY: "k",
    GROQ_API_KEY: "k",
    MINIMAX_API_KEY: "k",
    DASHSCOPE_API_KEY: "k",
    CEREBRAS_API_KEY: "k",
    ARTIFICIAL_ANALYSIS_API_KEY: "k",
  });
  const deduplicated = ["api-models", "news", "deprecations", "incidents", "web", "pages"];
  const unmapped = buildSourceRegistry(openDatabase(":memory:"), config)
    .filter((definition) => definition.authority === "first_party" && deduplicated.includes(definition.stream))
    .filter((definition) => !sourceIndependenceFamily(definition.id, definition.stream).startsWith("first-party:"))
    .map((definition) => definition.id);
  expect(unmapped).toEqual([]);
});
