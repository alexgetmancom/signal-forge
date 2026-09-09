import { expect, test } from "bun:test";
import { attentionScore, huggingFaceAttentionScore } from "../src/attention.js";

const now = Date.parse("2026-09-10T12:00:00.000Z");

test("attention scoring is deterministic and separate from confidence", () => {
  const input = {
    name: "Acme LLM agent",
    description: "A multimodal inference benchmark with reasoning support",
    topics: ["artificial-intelligence"],
    created: "2026-09-10T11:00:00.000Z",
    stars: 50,
    forks: 3,
  };
  const first = attentionScore(input, now);
  const second = attentionScore(input, now);
  expect(first).toEqual(second);
  expect(first).toEqual({
    score: 70,
    reasons: ["created-within-24h", "stars-50-plus", "forks-3-plus", "ai-keyword-match", "technical-term-match"],
  });
});

test("attention is capped and Hugging Face adds deterministic popularity reasons", () => {
  const result = huggingFaceAttentionScore(
    {
      name: "openai/transformer",
      created: "2026-09-10T11:00:00.000Z",
      downloads: 100_000,
      likes: 100,
      pipelineTag: "text-generation",
      tags: ["transformers"],
    },
    now,
  );
  expect(result.score).toBe(85);
  expect(result.reasons).toEqual([
    "created-within-24h",
    "ai-keyword-match",
    "technical-term-match",
    "downloads-100k-plus",
    "likes-100-plus",
    "model-pipeline-match",
  ]);
});
