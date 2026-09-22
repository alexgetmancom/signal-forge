import { expect, test } from "bun:test";
import { signalClass } from "../src/events/signals.js";
import type { Event } from "../src/events/types.js";
import { claudeModelIds } from "../src/sources/claudeCode.js";
import { commandCodeModelIds, isFreeModel, isSmallModel, servedModel } from "../src/sources/codingPlans.js";
import { skuModels } from "../src/sources/googleSkus.js";
import { kimiQuickstarts, minimaxReleases, qwenPosts } from "../src/sources/labPages.js";
import { parseAnthropicRoutes } from "../src/sources/news.js";
import { modelPages } from "../src/sources/sitemaps.js";

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

test("Command Code's CLI names its models, hidden ones included, once per id", () => {
  const bundle = `"moonshotai/Kimi-K3" "moonshotai/kimi-k3" "thinkingmachines/inkling" "MiniMaxAI/MiniMax-M3-Free" "openai/v1" "claude-sonnet-4-20250514" "gpt-6-astra"`;
  expect(commandCodeModelIds(bundle)).toEqual([
    "gpt-6-astra",
    "minimaxai/minimax-m3-free",
    "moonshotai/kimi-k3",
    "thinkingmachines/inkling",
  ]);
});

test("a free model is a headline unless it is a small variant", () => {
  expect(isFreeModel("nemotron-3-ultra-free")).toBe(true);
  expect(isFreeModel("tencent/hy3:free")).toBe(true);
  expect(isFreeModel("big-pickle")).toBe(true);
  expect(isFreeModel("glm-5.3")).toBe(false);
  expect(isSmallModel("nemotron-3.5-lightning-free")).toBe(true);
  expect(isSmallModel("minimaxai/minimax-m3-free")).toBe(false);
});

test("a big model going free on a coding plan is a launch, any other new name a sighting", () => {
  const event = (id: string, headline: boolean) =>
    ({
      id: 1,
      source: "opencode-zen",
      stream: "api-models",
      entity_id: id,
      kind: "new",
      before_json: null,
      after_json: JSON.stringify({ id, name: id, free: headline, headline }),
      detected_at: "2026-09-22T12:00:00.000Z",
    }) as unknown as Event;
  expect(signalClass(event("nemotron-3-ultra-free", true))).toBe("launch");
  expect(signalClass(event("omen-alpha", false))).toBe("codename");
});

test("a lab's sitemap gives the pages of its models, not the stories about them", () => {
  const xml = ["/index/gpt-6-astra/", "/index/gpt-5-6-in-kiro/", "/models/model-cards/gemini-3-8-flash/", "/careers/"]
    .map((path) => `<loc>https://openai.com${path}</loc>`)
    .join("");
  expect(modelPages(xml)).toEqual([
    "https://openai.com/index/gpt-6-astra",
    "https://openai.com/models/model-cards/gemini-3-8-flash",
  ]);
});

test("Xiaomi's and Z.ai's model pages, and Meta's Muse posts, are read like the others", () => {
  const xml = [
    "/models/zh-CN/mimo-v2.6-pro",
    "/news/latest/v2-6",
    "/guides/llm/glm-5.3",
    "/devpack/notice/event-glm-5.3-flash",
  ]
    .map((path) => `<loc>https://x.test${path}</loc>`)
    .join("");
  expect(modelPages(xml)).toEqual(["https://x.test/models/zh-CN/mimo-v2.6-pro", "https://x.test/guides/llm/glm-5.3"]);
  const blog = [
    "/blog/introducing-muse-spark-meta-model-api/",
    "/blog/brain2qwerty-brain-ai-human-communication/",
    "/blog/?page=2",
  ]
    .map((path) => `<a href="https://ai.meta.com${path}">`)
    .join("");
  expect(modelPages(blog, /(?:^|-)(?:muse|llama)(?:-|$)/)).toEqual([
    "https://ai.meta.com/blog/introducing-muse-spark-meta-model-api",
  ]);
});

test("a free serving is of the model it serves, so the two join one story", () => {
  expect(servedModel("grok-4.7-free")).toBe("grok-4.7");
  expect(servedModel("tencent/hy3:free")).toBe("tencent/hy3");
  expect(servedModel("big-pickle")).toBe("big-pickle");
});

test("Qwen's posts, MiniMax's release cards and Kimi's quickstarts are read from the pages behind their sites", () => {
  expect(
    qwenPosts(JSON.stringify({ data: { articles: [{ id: "a1", title: "Qwen3.6-Plus" }, { title: "no id" }] } })),
  ).toEqual([{ id: "a1", name: "Qwen3.6-Plus", maker: "Qwen", url: "https://qwen.ai/blog?id=a1" }]);
  expect(
    minimaxReleases(
      `#### Jul. 31, 2026\n<Card title="MiniMax H3" icon="video" href="https://www.minimax.io/blog/minimax-h3" cta="Learn More">`,
    ),
  ).toEqual([
    { id: "MiniMax H3", name: "MiniMax H3", maker: "MiniMax", url: "https://www.minimax.io/blog/minimax-h3" },
  ]);
  expect(
    kimiQuickstarts(
      "- [Kimi K3](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart.md): x\n- [Chat](https://platform.kimi.ai/docs/api/chat.md): y",
    ).map((page) => page.name),
  ).toEqual(["Kimi K3"]);
});
