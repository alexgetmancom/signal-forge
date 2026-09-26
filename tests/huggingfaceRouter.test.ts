import { expect, test } from "bun:test";
import { notificationBlock } from "../src/events/notification.js";
import { signalClass } from "../src/events/signals.js";
import type { Event } from "../src/events/types.js";
import { collectHuggingFaceRouter } from "../src/sources/registries.js";

// The shape the router answered with on 2026-09-17, trimmed to two hosts.
const model = (latency: number) => ({
  id: "deepseek-ai/DeepSeek-V4.1-Flash",
  object: "model",
  created: 1789006678,
  owned_by: "deepseek-ai",
  providers: [
    {
      provider: "novita",
      status: "live",
      context_length: 1048576,
      pricing: { input: 0.3 },
      first_token_latency_ms: latency,
    },
    { provider: "fireworks-ai", status: "live", context_length: 1048576, throughput: latency / 10 },
    { provider: "together", status: "staging", context_length: 2000000 },
  ],
});

test("a router model keeps its live hosts and drops the numbers that move on every read", async () => {
  const first = await collectHuggingFaceRouter(async () => Response.json({ object: "list", data: [model(1027)] }));
  const second = await collectHuggingFaceRouter(async () => Response.json({ object: "list", data: [model(714)] }));
  expect(first.records).toEqual([
    {
      id: "deepseek-ai/DeepSeek-V4.1-Flash",
      name: "deepseek-ai/DeepSeek-V4.1-Flash",
      maker: "Hugging Face",
      url: "https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash",
      owner: "deepseek-ai",
      created: "2026-09-10T02:17:58.000Z",
      context: 1048576,
      providers: ["fireworks-ai", "novita"],
    },
  ]);
  expect(JSON.stringify(second.raw)).toBe(JSON.stringify(first.raw));
});

test("an empty router answer is a failed read", async () => {
  await expect(collectHuggingFaceRouter(async () => Response.json({ object: "list", data: [] }))).rejects.toThrow();
});

test("a model reaching the router is a sighting and a host joining it is silent", () => {
  const record = {
    id: "deepseek-ai/DeepSeek-V4.1-Flash",
    name: "deepseek-ai/DeepSeek-V4.1-Flash",
    providers: ["novita"],
  };
  const event = (kind: Event["kind"], before: object | null, after: object): Event => ({
    signal: null,
    id: 1,
    source: "huggingface-router",
    stream: "api-models",
    entity_id: record.id,
    kind,
    before_json: before ? JSON.stringify(before) : null,
    after_json: JSON.stringify(after),
    detected_at: "2026-09-17T00:00:00.000Z",
  });
  expect(signalClass(event("new", null, record))).toBe("codename");
  expect(notificationBlock(event("changed", record, { ...record, providers: ["fireworks-ai", "novita"] }))).toBe(
    "A host joined or left a model, the model did not change",
  );
});
