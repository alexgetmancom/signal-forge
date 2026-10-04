import { expect, test } from "bun:test";
import type { Event } from "../src/events/types.js";
import {
  arrivalWeight,
  isAnEvaluation,
  isModelVariant,
  isRepublished,
  isTrainingArtefact,
  modelSubject,
  oneLinePerModel,
  precisionBase,
  servesAnotherModality,
} from "../src/events/variants.js";

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

test("a numbered row and a training checkpoint are not releases", () => {
  // DeepSeek re-keyed its pricing table: the numbered rows were a model from the spring and a
  // launch the weights had already announced.
  expect(isModelVariant("deepseek-v4-pro (2)")).toBe(true);
  expect(isModelVariant("deepseek-flash (1)")).toBe(true);
  expect(isModelVariant("deepseek-flash")).toBe(false);
  expect(isTrainingArtefact("nvidia/Nemotron-3-Labs-Ultra-Math-SFT")).toBe(true);
  expect(isTrainingArtefact("nvidia/Nemotron-3-Labs-Ultra-Math-RL")).toBe(true);
  expect(isTrainingArtefact("Qwen3-14B-Base")).toBe(true);
  // A tier is a product; only the stages of making one are excluded.
  expect(isTrainingArtefact("deepseek-ai/DeepSeek-V4.1-Flash")).toBe(false);
  expect(isTrainingArtefact("gpt-image-2.5-flare")).toBe(false);
});

test("a catalogue restating one model is one line", () => {
  // TrueFoundry's four rows for MAI Image 2.6 on 2026-09-25: the model, a dated snapshot of it, its
  // Flash tier and a snapshot of that. Flash is a model somebody chose to sell; the dates are not.
  const collapsed = oneLinePerModel([
    { name: "MAI-Image-2.6", reseller: "TrueFoundry", maker: "Microsoft" },
    { name: "MAI-Image-2.6-2026-07-31", reseller: "TrueFoundry", maker: "Microsoft" },
    { name: "MAI-Image-2.6-Flash", reseller: "TrueFoundry", maker: "Microsoft" },
    { name: "MAI-Image-2.6-Flash-2026-07-31", reseller: "TrueFoundry", maker: "Microsoft" },
  ]);
  expect(collapsed.map((entry) => [entry.name, entry.variants, entry.alsoOn])).toEqual([
    ["MAI-Image-2.6", 1, []],
    ["MAI-Image-2.6-Flash", 1, []],
  ]);
});

test("a second shop listing one model is one line naming both, not a variant of it", () => {
  const collapsed = oneLinePerModel([
    { name: "Ember 1", reseller: "Vercel AI Gateway", maker: "fireworks" },
    { name: "Fireworks: Ember-1", reseller: "OpenRouter", maker: "fireworks" },
  ]);
  expect(collapsed).toHaveLength(1);
  expect(collapsed[0]?.variants).toBe(0);
  expect(collapsed[0]?.alsoOn).toEqual(["OpenRouter"]);
});

test("a dated snapshot is named by the model it is a build of", () => {
  // The base was listed in April and only the snapshot arrived, so the group has nothing plainer to
  // be named by: "MAI Image 2e 2026 04 09" is a deployment date read as part of a model's name.
  const collapsed = oneLinePerModel([{ name: "MAI-Image-2e-2026-04-09", reseller: "TrueFoundry", maker: "Microsoft" }]);
  expect(collapsed[0]?.name).toBe("MAI-Image-2e");
});

test("a model that answers in pictures or sound is a different craft", () => {
  // The word in the middle of the name, which the trailing-word fold never reached.
  expect(servesAnotherModality("Grok Imagine Video 1.5 Lite")).toBe(true);
  expect(servesAnotherModality("MAI-Voice-2.1-Flash")).toBe(true);
  expect(servesAnotherModality("Cohere Embed 5 Pro")).toBe(true);
  expect(servesAnotherModality("Claude Sonnet 5.5")).toBe(false);
  expect(servesAnotherModality("Ling 3.1 Flash")).toBe(false);
});

test("a catalogue's own modalities outrank the name, and a token ceiling is not a modality", () => {
  const picture = { id: "x", name: "Something Neutral", output: ["image"] };
  expect(servesAnotherModality("Something Neutral", picture)).toBe(true);
  const text = { id: "x", name: "Imagine Reasoner", output: ["text"] };
  expect(servesAnotherModality("Imagine Reasoner", text)).toBe(false);
  // models.dev spells `output` as a token ceiling; read as a modality it calls everything a picture.
  const ceiling = { id: "x", name: "Claude Sonnet 5.5", output: 128000 };
  expect(servesAnotherModality("Claude Sonnet 5.5", ceiling)).toBe(false);
});

test("a grader published by a watched lab is not that lab's release", () => {
  expect(isAnEvaluation("internlm/AdvancedMathBench-AutoVerifier")).toBe(true);
  expect(isAnEvaluation("SWE-bench-verified")).toBe(true);
  expect(isAnEvaluation("Qwen3-Coder-Eval")).toBe(true);
  expect(isAnEvaluation("Claude Sonnet 5.5")).toBe(false);
  expect(isAnEvaluation("Kolibri-1")).toBe(false);
});

test("a lab's own FP8 build is the release at another precision", () => {
  const base = modelSubject("Aleph-Alpha/Kolibri-1");
  expect(precisionBase("Aleph-Alpha/Kolibri-1-BF16")).toBe(base);
  expect(precisionBase("Aleph-Alpha/Kolibri-1-FP8")).toBe(base);
  expect(precisionBase("Aleph-Alpha/Kolibri-1")).toBe(null);
  // A name that ends in a number is not a precision: Llama 4 Scout 17B is the model.
  expect(precisionBase("Llama 4 Scout 17B Instruct")).toBe(null);
});
