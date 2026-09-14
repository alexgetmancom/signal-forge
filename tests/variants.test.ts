import { expect, test } from "bun:test";
import type { Event } from "../src/events/types.js";
import { arrivalWeight, isModelVariant, isRepublished, modelSubject } from "../src/events/variants.js";

test("a tier, an alias and a snapshot are not releases", () => {
  expect(isModelVariant("DeepSeek: DeepSeek V4 Flash 0731 (batch)")).toBe(true);
  expect(isModelVariant("Nex AGI: Nex-N2.5-Mini (free)")).toBe(true);
  expect(isModelVariant("OpenAI GPT Astra Latest")).toBe(true);
  expect(isModelVariant("gpt-image-2.5-flare-2026-09-08")).toBe(true);
  expect(isModelVariant("DeepSeek: DeepSeek V4.1 Flash")).toBe(false);
  expect(isModelVariant("gpt-image-2.5-flare")).toBe(false);
});

test("one model seen by three collectors is one model", () => {
  const subject = modelSubject("DeepSeek: DeepSeek V4.1 Flash");
  expect(modelSubject("deepseek-ai/DeepSeek-V4.1-Flash")).toBe(subject);
  expect(modelSubject("DeepSeek: DeepSeek V4.1 Flash (batch)")).toBe(subject);
  expect(modelSubject("Z.ai: GLM 5.3")).not.toBe(subject);
});

test("somebody else's quantisation is not that vendor's launch", () => {
  const event = { entity_id: "nvidia/Qwen3.8-27B-NVFP4", stream: "weights" } as Event;
  expect(isRepublished(event, { id: "nvidia/Qwen3.8-27B-NVFP4", name: "nvidia/Qwen3.8-27B-NVFP4" })).toBe(true);
  const own = { entity_id: "deepseek-ai/DeepSeek-V4.1-Flash", stream: "weights" } as Event;
  expect(isRepublished(own, { id: "deepseek-ai/DeepSeek-V4.1-Flash", name: "deepseek-ai/DeepSeek-V4.1-Flash" })).toBe(
    false,
  );
});

test("the maker's own word outweighs a reseller's catalogue", () => {
  expect(arrivalWeight({ stream: "weights" } as Event)).toBeGreaterThan(
    arrivalWeight({ stream: "openrouter" } as Event),
  );
  expect(arrivalWeight({ stream: "api-models" } as Event)).toBeGreaterThan(
    arrivalWeight({ stream: "openrouter" } as Event),
  );
});
