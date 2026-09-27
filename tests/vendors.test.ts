import { expect, test } from "bun:test";
import { vendorOfEvidence, vendorOfName } from "../src/events/vendors.js";

test("a maker is read off the name the catalogues publish, including the families it does not sign", () => {
  // Every one of these spent September as Unknown, which is a card with no maker on it.
  expect(vendorOfName("Gemma 4 31B IT")).toBe("Google");
  expect(vendorOfName("DiffusionGemma")).toBe("Google");
  expect(vendorOfName("Pixtral Large (25.02)")).toBe("Mistral");
  expect(vendorOfName("Devstral 2 123B")).toBe("Mistral");
  expect(vendorOfName("Command A+")).toBe("Cohere");
  expect(vendorOfName("Muse Glimmer 30B")).toBe("Meta");
  expect(vendorOfName("Hy4 preview")).toBe("Tencent");
  expect(vendorOfName("Inkling-Small")).toBe("Thinking Machines");
  expect(vendorOfName("LongCat 2.5 Preview")).toBe("Meituan");
  expect(vendorOfName("Ember-1")).toBe("Fireworks");
  expect(vendorOfName("Arrow 2 Telos")).toBe("Quiver AI");
  expect(vendorOfName("Toast 1")).toBe("Mixedbread");
});

test("a fine-tuner is the maker of what it tuned, not the lab whose base it started from", () => {
  expect(vendorOfName("aisingapore/Gemma-SEA-LION-v4-27B-IT")).toBe("AI Singapore");
});

test("the words these patterns share with ordinary text do not claim it", () => {
  // `ember` is the tail of two month names, and `command` starts a source id and a product name.
  expect(vendorOfName("https://www.anthropic.com/news/september-threat-report")).toBe("Anthropic");
  expect(vendorOfEvidence({ name: "Some Model", source: "command-code-models" })).toBe("Unknown");
  expect(vendorOfName("Claude Code 2.1.278")).toBe("Anthropic");
});

test("a maker named only in the record's own fields is still placed", () => {
  expect(vendorOfEvidence({ name: "Toast 1", maker: "mixedbread" })).toBe("Mixedbread");
  expect(vendorOfEvidence({ name: "Nothing Recognisable" })).toBe("Unknown");
});
