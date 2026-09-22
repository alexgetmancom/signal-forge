import { expect, test } from "bun:test";
import { claudeModelIds } from "../src/sources/claudeCode.js";
import { skuModels } from "../src/sources/googleSkus.js";
import { parseAnthropicRoutes } from "../src/sources/news.js";

test("the Claude Code binary's model ids, aliases read as their model, tools named like models dropped", () => {
  const binary = `"claude-opus-4-8" x claude-sonnet-4-5-20250929 claude-opus-4-1-v1 claude-eval-9 claude-desktop-3p
    anthropic.claude-haiku-4-5-0 claude-mythos-5-1 claude-fable-5`;
  expect(claudeModelIds(binary)).toEqual([
    "claude-fable-5",
    "claude-haiku-4-5",
    "claude-mythos-5-1",
    "claude-opus-4-1",
    "claude-opus-4-8",
    "claude-sonnet-4-5",
  ]);
});

test("a launch page in anthropic.com's route list is read before it is linked", () => {
  const html = String.raw`[\"slug\",\"news\",\"oc\",[\"careers\",\"claude-corps\",\"claude-fable-and-mythos-5-1\",\"claude-opus-5-5\"]] \"/claude-fable-and-mythos-5-1\"`;
  expect(parseAnthropicRoutes(html).records.map((record) => record.id)).toEqual([
    "claude-fable-and-mythos-5-1",
    "claude-opus-5-5",
  ]);
});

test("a model priced on Google Cloud is named once however it is billed", () => {
  expect(
    skuModels([
      "Generate content input token count gemini 3.8 flash lite tts text batch",
      "Generate content cached input token count gemini 3.8 flash tts text",
      "Gemini 3.8 Flash Cyber Global Text Input Caching Offpeak",
      "Cloud Vertex AI Model Garden Model as a Service GLM-5.2 Input",
      "Vector Search Index Serving e2-standard-16",
    ]),
  ).toEqual(["gemini-3.8-flash-cyber", "gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts", "glm-5.2"]);
});
