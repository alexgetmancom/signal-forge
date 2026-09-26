/**
 * Every maker a registry entry is allowed to name.
 *
 * A vendor was a free string in seventy-six entries, and a free string repeated that many times is
 * a spelling waiting to drift: one entry saying "HuggingFace" and another "Hugging Face" makes two
 * makers out of one, and nothing would have said so -- the cards would simply have grouped wrong.
 * `tests/sourceKinds.test.ts` holds the registry against this list, which is why it can be a list
 * rather than a type: the vendor of a watched repository comes from the config file, where a type
 * cannot reach.
 *
 * This is how a maker is spelled *as a source's owner*. `src/events/vendors.ts` answers a different
 * question -- which maker a piece of text is about -- and deliberately spells six of these
 * differently, because "AWS" owns a catalogue while "Amazon" is who a reader hears about. Neither
 * list is derived from the other, and a name here is not required to appear there.
 */
export const VENDOR_NAMES = [
  "Alibaba",
  "Anthropic",
  "AWS",
  "Cerebras",
  "Cohere",
  "Cursor",
  "DeepInfra",
  "DeepSeek",
  "Google",
  "Groq",
  "Hugging Face",
  "Meta",
  "Microsoft",
  "MiniMax",
  "Mistral",
  "Moonshot",
  "NVIDIA",
  "OpenAI",
  "Perplexity",
  "Poolside",
  "Qwen",
  "StepFun",
  "Suno",
  "xAI",
  "Xiaomi",
  "Z.ai",
] as const;

export type Vendor = (typeof VENDOR_NAMES)[number];
