import type { Event, RecordData } from "./types.js";

/**
 * The first pattern that matches wins, so a first-party maker is listed before any cloud that
 * merely resells it: an Anthropic model on Bedrock is Anthropic's news, not Amazon's.
 *
 * Patterns that are short or double as ordinary words are anchored on word boundaries. `xai`
 * without them claims SpaceXAI, and a maker recorded as exactly "Meta" went to Unknown for a week
 * because the pattern demanded a trailing slash.
 */
const VENDORS: [RegExp, string][] = [
  [/openai|gpt|codex|chatgpt|sora/i, "OpenAI"],
  [/anthropic|claude/i, "Anthropic"],
  [/google|gemini|deepmind|lyria|imagen|veo/i, "Google"],
  [/\bx-ai\b|\bxai\b|grok/i, "xAI"],
  [/deepseek/i, "DeepSeek"],
  [/qwen|alibaba/i, "Qwen"],
  [/meta-llama|llama|\bmeta\b|muse[\s-]spark/i, "Meta"],
  [/mistral/i, "Mistral"],
  [/groq/i, "Groq"],
  [/moonshot|kimi/i, "Moonshot"],
  [/minimax/i, "MiniMax"],
  [/z-ai|\bzai\b|zhipu|glm/i, "Z.ai"],
  [/cohere/i, "Cohere"],
  [/perplexity/i, "Perplexity"],
  [/tencent|hunyuan/i, "Tencent"],
  [/bytedance|doubao/i, "ByteDance"],
  [/xiaomi|\bmimo\b/i, "Xiaomi"],
  [/baidu|ernie/i, "Baidu"],
  [/upstage|\bsolar\b/i, "Upstage"],
  // "step" alone is an ordinary word in a handle and a repository name; only the company's own
  // spelling and its numbered family count. Step 5 Preview spent a day recorded as Unknown because
  // neither was here, so its cards carried no maker and its events joined no vendor's story.
  [/stepfun|(?:^|[\s/~])step-\d/i, "StepFun"],
  [/black[\s-]?forest|\bflux\b/i, "Black Forest Labs"],
  [/\brunway\b/i, "Runway"],
  [/\bkling\b/i, "Kling"],
  [/recraft/i, "Recraft"],
  [/\bluma\b/i, "Luma"],
  [/\breve\b/i, "Reve"],
  [/sakana|\bfugu\b/i, "Sakana"],
  [/inclusionai|\bling-3\b|\bbailing\b/i, "inclusionAI"],
  [/inception\b|\bmercury-\d/i, "Inception"],
  [/nvidia|nemotron/i, "NVIDIA"],
  [/microsoft|azure|\bphi-\d/i, "Microsoft"],
  [/amazon|\baws\b|bedrock/i, "Amazon"],
  [/poolside/i, "Poolside"],
  // The lab behind InternLM brands its models Atria; `internlm` is where both are published.
  [/internlm|shanghai ai lab|\batria[\s-]dawn/i, "Shanghai AI Lab"],
  // `bonsai` alone also names other people's fine-tunes of PrismML's models.
  [/prism-?ml\b/i, "PrismML"],
  [/abacus|\bsmaug-(?:agentic|flash|mini)\b/i, "Abacus.AI"],
  // Jev reached the Vercel gateway on 2026-09-16, fifteen hours before any other catalogue, and
  // thirty repositories were built around it in the next three days. "typesafe" alone is an
  // ordinary word in repository names, so only the company's own spellings count.
  [/typesafe-ai|~?typesafe\/|\btypesafe:|\bjev\b/i, "Typesafe"],
];

/**
 * How a maker spells its own name, matched exactly and never by pattern.
 *
 * `vendorOfName` is deliberately loose -- `sora` is OpenAI's news -- which is the wrong tool for
 * casing a single word of a handle. This answers only for a word that is the maker's name.
 */
const SPELLINGS = new Map(VENDORS.map(([, label]) => [label.toLowerCase(), label]));

export function vendorSpelling(word: string): string | null {
  return SPELLINGS.get(word.toLowerCase()) ?? null;
}

/** The maker a piece of text names, or Unknown when it names none of the ones we track. */
export function vendorOfName(text: string): string {
  return VENDORS.find(([pattern]) => pattern.test(text))?.[1] ?? "Unknown";
}

/** The vendor an event is about, for role pings and presentation labels. */
export function vendorOf(event: Event, record: RecordData | null): string {
  // What the model calls itself, before who is hosting it. `maker` is filled in by whatever
  // catalogue was read, and a catalogue often writes its own name there: Alibaba Model Studio
  // lists GLM 5.3, and reading `maker` first filed Z.ai's model under Qwen in the weekly recap.
  // A name is the one field the maker controls, so it answers first and the host answers after.
  const named = [record?.name, event.entity_id].filter((value) => typeof value === "string").join(" ");
  const byName = named ? vendorOfName(named) : "Unknown";
  if (byName !== "Unknown") return byName;
  const haystack = [record?.maker, record?.provider, record?.owner, event.source]
    .filter((value) => typeof value === "string")
    .join(" ");
  return VENDORS.find(([pattern]) => pattern.test(haystack))?.[1] ?? "Unknown";
}
