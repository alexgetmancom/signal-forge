import { expect, test } from "bun:test";
import { displayTitle, readableName } from "../src/events/naming.js";

test("a catalogue handle is read back as the name of the thing", () => {
  expect(readableName("gpt-image-2.5-flare")).toBe("GPT Image 2.5 Flare");
  expect(readableName("gpt-live-1")).toBe("GPT Live 1");
  expect(readableName("deepseek-ai/DeepSeek-V4.1-Flash")).toBe("DeepSeek V4.1 Flash");
  expect(readableName("nvidia/Nemotron-3-Labs-Ultra-Math-RL")).toBe("Nemotron 3 Labs Ultra Math RL");
  expect(readableName("deepseek-flash (1)")).toBe("DeepSeek Flash");
});

test("a name somebody already wrote for a reader is left exactly as it is", () => {
  expect(readableName("Inception: Mercury 2.5")).toBe("Inception: Mercury 2.5");
  expect(readableName("GPT-6 Astra")).toBe("GPT-6 Astra");
  expect(readableName("claude")).toBe("claude");
});

test("a sighting keeps the characters somebody would search for", () => {
  expect(displayTitle("amber_fern", "arena", "arena")).toBe("amber_fern");
  expect(displayTitle("openai/whisper-next", "github", "discovery:github-ai")).toBe("openai/whisper-next");
  expect(displayTitle("gpt-image-2.5-flare", "api-models", "openai")).toBe("GPT Image 2.5 Flare");
});
