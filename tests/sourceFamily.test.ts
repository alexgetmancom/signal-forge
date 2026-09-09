import { expect, test } from "bun:test";
import { sourceFamily } from "../src/events/sourceFamily.js";

test("source families collapse discovery queries but preserve independent surfaces", () => {
  expect(sourceFamily("discovery:github-ai", "github")).toBe("discovery:github");
  expect(sourceFamily("discovery:github-mcp", "github")).toBe("discovery:github");
  expect(sourceFamily("github:openai/codex:pulls", "github")).toBe("github");
  expect(sourceFamily("github:openai/codex:commits", "github")).toBe("github");
  expect(sourceFamily("huggingface:openai", "weights")).toBe("huggingface");
  expect(sourceFamily("discovery:huggingface-recent", "weights")).toBe("huggingface");
  expect(sourceFamily("openai", "api-models")).toBe("provider-api");
  expect(sourceFamily("openai-news", "news")).toBe("official-news");
  expect(sourceFamily("new-surface")).toBe("new-surface");
});
