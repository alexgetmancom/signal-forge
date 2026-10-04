import { text } from "../text.js";
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
  // AI Singapore before Google, for the reason Anthropic comes before Bedrock: `sea-lion` is
  // published as `aisingapore/Gemma-SEA-LION-v4-27B-IT`, and whoever tuned a model is its maker.
  [/aisingapore|sea-?lion/i, "AI Singapore"],
  // `gemma` was missing until 2026-09-27, and eleven Gemma 4 listings in one month carried no maker
  // on their cards because of it -- the failure a missing pattern has, which is silence.
  [/google|gemini|gemma|deepmind|lyria|imagen|veo/i, "Google"],
  [/\bx-ai\b|\bxai\b|grok/i, "xAI"],
  [/deepseek/i, "DeepSeek"],
  [/qwen|alibaba/i, "Qwen"],
  [/meta-llama|llama|\bmeta\b|muse[\s-](?:spark|glimmer)/i, "Meta"],
  // The families Mistral does not put its own name on. Pixtral Large and Devstral 2 were the two
  // largest Unknown handles of September by event count, at 35 listings between them.
  [/mistral|\bpixtral\b|\bdevstral\b/i, "Mistral"],
  [/groq/i, "Groq"],
  [/moonshot|kimi/i, "Moonshot"],
  [/minimax/i, "MiniMax"],
  // `z.ai` with the dot is how the lab writes its own name, and the pattern that had only `z-ai`
  // did not place the spelling the registry uses for it: check-vendors found that on 2026-10-04.
  [/z\.?-?ai|\bzai\b|zhipu|glm/i, "Z.ai"],
  // Command A+ reaches us from catalogues that leave `maker` empty, and the word "cohere" is
  // nowhere in the name. Only the lettered families count: `command-code-models` is a source id.
  [/cohere|\bcommand[\s-]?(?:a\+|[ar])\b/i, "Cohere"],
  [/perplexity/i, "Perplexity"],
  [/tencent|hunyuan|\bhy\d/i, "Tencent"],
  [/bytedance|doubao/i, "ByteDance"],
  [/xiaomi|\bmimo\b/i, "Xiaomi"],
  [/baidu|ernie/i, "Baidu"],
  [/upstage|\bsolar\b/i, "Upstage"],
  // `kolibri` as well as the handle: the weights are published as `Aleph-Alpha/Kolibri-1`, but a
  // catalogue that picks the family up later will carry only the family's own name.
  [/aleph[\s-]?alpha|\bkolibri\b|\bpharia\b/i, "Aleph Alpha"],
  // "step" alone is an ordinary word in a handle and a repository name; only the company's own
  // spelling and its numbered family count. Step 5 Preview spent a day recorded as Unknown because
  // neither was here, so its cards carried no maker and its events joined no vendor's story.
  [/stepfun|(?:^|[\s/~])step-\d/i, "StepFun"],
  [/aion-labs|\baion[\s-]\d/i, "AionLabs"],
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
  // Thinky is the brand, Thinking Machines is the lab, Inkling is the model, and the three
  // catalogues that list it use one each.
  [/thinking[\s-]?machines|\bthinky\b|\binkling\b/i, "Thinking Machines"],
  [/nex-?agi|\bnex[\s-]?n\d/i, "Nex AGI"],
  [/meituan|\blongcat\b/i, "Meituan"],
  [/kwaipilot|\bkat-coder/i, "Kwaipilot"],
  [/ibm-granite|\bibm\b|\bgranite[\s-]?\d/i, "IBM"],
  // The namespace as well as the name, because `liquid/d1` is how the catalogues publish it and
  // "liquid" on its own is an ordinary word in a handle.
  [/liquid[\s-]?ai|\bliquid\/|\blfm\d/i, "Liquid AI"],
  [/swiss-ai|\bapertus\b/i, "Swiss AI"],
  [/inference\.net|\bschematron\b/i, "Inference.net"],
  [/perceptron/i, "Perceptron"],
  // `ember` is also the tail of two month names, which is why the digit and the boundary are both
  // required: without them every September newsroom URL was a Fireworks release.
  [/fireworks|\bember[\s-]\d/i, "Fireworks"],
  // Known to us only by a model name that is an ordinary word, because the catalogues that carry
  // the maker are outnumbered by the ones that do not. After every laboratory that signs its own
  // models and before the clouds, for the reason the whole list is ordered that way: TrueFoundry
  // publishes Toast 1 as `azure-ai-foundry/Toast-1`, and a host's namespace is not a maker.
  [/quiverai|\barrow[\s-]?\d/i, "Quiver AI"],
  [/mixedbread|\btoast[\s-]?\d/i, "Mixedbread"],
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

/**
 * The three makers a reader of this feed is actually here for, in the order they are read in.
 *
 * Everything else is ranked behind them and keeps its existing order. Without this the week was
 * ordered by which collector saw a model first, and on 27 September that put four Xiaomi billing
 * tiers above Claude Opus 5.5 and pushed Gemini and DeepSeek out of the message entirely.
 */
const HEADLINE_VENDORS = ["Anthropic", "OpenAI", "Google"];

/** Where a maker sorts in anything a reader scans: lower is earlier. */
export function vendorRank(vendor: string): number {
  const place = HEADLINE_VENDORS.indexOf(vendor);
  return place === -1 ? HEADLINE_VENDORS.length : place;
}

/** The maker a piece of text names, or Unknown when it names none of the ones we track. */
export function vendorOfName(text: string): string {
  return VENDORS.find(([pattern]) => pattern.test(text))?.[1] ?? "Unknown";
}

/**
 * The fields a maker's identity can be read off, in the order they are trusted.
 *
 * `vendorOf` reads them from one event; `unknown-makers` reads the same four columns for a window
 * of events without lifting the record bodies. They are one function so that the report measures
 * the rule the channel runs on rather than a second copy of it that drifts a release later.
 */
export type VendorEvidence = {
  name?: string | null;
  entityId?: string | null;
  maker?: string | null;
  provider?: string | null;
  owner?: string | null;
  source?: string | null;
};

/** The maker the recorded fields name, or Unknown when they name none of the ones we track. */
export function vendorOfEvidence(evidence: VendorEvidence): string {
  // What the model calls itself, before who is hosting it. `maker` is filled in by whatever
  // catalogue was read, and a catalogue often writes its own name there: Alibaba Model Studio
  // lists GLM 5.3, and reading `maker` first filed Z.ai's model under Qwen in the weekly recap.
  // A name is the one field the maker controls, so it answers first and the host answers after.
  const named = [evidence.name, evidence.entityId].filter((value) => typeof value === "string").join(" ");
  const byName = named ? vendorOfName(named) : "Unknown";
  if (byName !== "Unknown") return byName;
  const haystack = [evidence.maker, evidence.provider, evidence.owner, evidence.source]
    .filter((value) => typeof value === "string")
    .join(" ");
  return VENDORS.find(([pattern]) => pattern.test(haystack))?.[1] ?? "Unknown";
}

/** The vendor an event is about, for role pings and presentation labels. */
export function vendorOf(event: Event, record: RecordData | null): string {
  return vendorOfEvidence({
    name: text(record?.name),
    entityId: event.entity_id,
    maker: text(record?.maker),
    provider: text(record?.provider),
    owner: text(record?.owner),
    source: event.source,
  });
}
