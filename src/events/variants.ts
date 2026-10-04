import { normalizeIdentity } from "./identity.js";
import type { Event, RecordData } from "./types.js";
import { vendorOfName } from "./vendors.js";

/**
 * Telling a model apart from another way of billing it.
 *
 * A catalogue lists one model several times: a batch tier, a free tier, an alias that always points
 * at the newest build, and a dated snapshot of the build it pointed at yesterday. Every one of those
 * arrives as a new record with its own price, and counted as a launch it turns a week with nine
 * models in it into a week with thirty-seven. The first weekly recap said exactly that, and led with
 * a batch tier of a model that had shipped in July.
 *
 * None of this is a judgement about importance. It is reading what the catalogue itself says the
 * entry is, from the name it gave it.
 */
const VARIANT_SUFFIX =
  /\((batch|free|beta|preview|alpha|experimental|self[- ]moderated|extended|thinking|latest|fast|non[- ]?reasoning|reasoning)\)\s*$/i;
const ALIAS_SUFFIX = /[:\s-](latest|preview)$/i;
/**
 * An alias that says out loud what it points at. Alibaba lists `Qwen Max Latest (Qwen3.8 Max)`:
 * the row is a pointer at the newest build, and the build is named in its own brackets.
 */
const ALIAS_PARENS = /\b(latest|preview)\s*\(.+\)\s*$/i;
const DATED_SNAPSHOT = /[-:]\d{4}-\d{2}-\d{2}$/;
/**
 * A row the collector had to disambiguate, which means the catalogue already carries this model.
 *
 * DeepSeek re-keyed its pricing table on 10 September: `deepseek-flash (1)` and `deepseek-v4-pro (2)`
 * arrived as new entries and the original ids were dropped half an hour later. One of those was a
 * genuine launch that the weights had already announced; the other was a model from the spring. A
 * numbered row is a second way of writing something present, never a release.
 */
const DUPLICATE_ROW = /\(\d+\)\s*$/;
/**
 * Stages of making a model, published as weights beside it.
 *
 * `Nemotron-3-Labs-Ultra-Math-RL` and `-SFT` are two checkpoints of one training run. They are real
 * artefacts and they are not releases, and a recap that lists them spends its most-read line on
 * research bookkeeping.
 */
const TRAINING_ARTEFACT =
  /[-_.\s](sft|rl|rlhf|dpo|ppo|grpo|mopd|rm|reward|base|pretrain|lora|adapter|checkpoint|ckpt|distill|distilled)$/i;

/** True when this entry is another way of selling a model the catalogue already lists. */
export function isModelVariant(name: string): boolean {
  const trimmed = name.trim();
  return (
    VARIANT_SUFFIX.test(trimmed) ||
    ALIAS_SUFFIX.test(trimmed) ||
    ALIAS_PARENS.test(trimmed) ||
    DATED_SNAPSHOT.test(trimmed) ||
    DUPLICATE_ROW.test(trimmed)
  );
}

/**
 * True when a published artefact is not a model somebody can run, or is somebody's edit of one.
 *
 * A registry carries far more than releases. `google/gnm-v3` is a parametric 3D model of a human
 * head -- a real publication by Google, and nothing a reader of this feed can call or run -- and it
 * says so itself: it declares no inference pipeline at all, only `3d`, `mesh` and `computer-vision`
 * tags. `NVIDIA-NemotronLabs-AI-for-Media-Sports-Tennis` declares the model it was fine-tuned from,
 * which is the registry's own way of saying this is a derivative rather than a launch.
 *
 * Both facts come from the record. Nothing here judges whether the work is interesting.
 */
export function isBesideTheRelease(record: RecordData | null): boolean {
  if (!record) return false;
  const tags = Array.isArray(record.tags) ? record.tags.map(String) : [];
  if (tags.some((tag) => /^base_model:(finetune|quantized|adapter|merge):/i.test(tag))) return true;
  // A registry that does not report a pipeline at all has not said anything; one that reports an
  // empty one has said this is not something to run.
  if (!("pipeline" in record) && !("category" in record)) return false;
  const pipeline = record.pipeline ?? record.category;
  return typeof pipeline === "string" ? !pipeline.trim() : pipeline === null || pipeline === undefined;
}

/** True when this entry is a step in training a model rather than a model offered to anyone. */
export function isTrainingArtefact(name: string): boolean {
  return TRAINING_ARTEFACT.test(name.trim());
}

/**
 * The model behind an entry, with the billing and the snapshot stripped off.
 *
 * `DeepSeek: DeepSeek V4.1 Flash`, `deepseek-ai/DeepSeek-V4.1-Flash` and `deepseek-flash (1)` are
 * one release seen by three collectors, and a recap that counts them separately is counting
 * collectors rather than models.
 */
export function modelSubject(name: string): string {
  const stripped = name
    .trim()
    .replace(VARIANT_SUFFIX, "")
    .replace(ALIAS_PARENS, "$1")
    .replace(ALIAS_SUFFIX, "")
    .replace(DATED_SNAPSHOT, "")
    .replace(/\s*\(\d+\)\s*$/, "")
    .replace(/^[^:/]+[:/]/, "");
  return normalizeIdentity(stripped) || normalizeIdentity(name);
}

/**
 * A model name with its release channel taken off, for asking whether the model itself is out.
 *
 * LiteLLM named thirteen strings on 2026-09-23 -- `grok-4.20-beta-latest-non-reasoning`,
 * `-experimental-beta-0304`, `-reasoning-gv2` and so on -- and every one reached the radar saying
 * it was in no catalogue. Grok 4.20 had been answering on the API since March. These are routes to
 * one released model, not thirteen sightings. Only the routing words come off: `flash`, `fast`,
 * `mini` and `pro` are what a maker sells as separate models, and stripping those would silence a
 * real launch.
 */
const ROUTING_WORD = /^(beta|latest|preview|experimental|stable|ga|rc|gv\d+|non|reasoning|thinking|\d{4})$/;

export function releasedModelSubject(name: string): string {
  const words = normalizeIdentity(name.replace(/^[^:/]+[:/]/, "")).split(" ");
  while (words.length > 1 && ROUTING_WORD.test(words.at(-1) ?? "")) words.pop();
  return words.join("");
}

/**
 * True when this record is somebody else republishing another maker's model.
 *
 * `nvidia/Qwen3.8-27B-NVFP4` is a quantisation of Alibaba's model, not a launch by NVIDIA, and six
 * of them in a week read as a flood of NVIDIA releases that never happened. The owner of a registry
 * namespace is in the id; whose model it is, is in the name.
 */
export function isRepublished(event: Event, record: RecordData | null): boolean {
  const id = String(record?.id ?? event.entity_id);
  const owner = id.split("/")[0] ?? "";
  const subject = id.slice(id.indexOf("/") + 1);
  if (!owner || !id.includes("/")) return false;
  // Only a subject that names a maker we track can contradict the namespace it sits in. A model
  // whose name says nothing about its maker -- `google/gnm-v3` -- is left alone rather than guessed
  // at, because a wrong call here deletes a real launch from the week.
  const maker = vendorOfName(subject);
  return maker !== "Unknown" && !owner.toLowerCase().includes(maker.toLowerCase());
}

/**
 * How much a card is worth leading a summary with.
 *
 * A maker publishing its own weights or listing a model in its own API is the release; the same
 * model appearing in a reseller's catalogue is the same news arriving second-hand.
 */
/** The name without the catalogue's own bookkeeping: `deepseek-flash (1)` is `deepseek-flash`. */
export function displayName(name: string): string {
  return name.replace(/\s*\(\d+\)\s*$/, "").trim();
}

export function arrivalWeight(event: Event): number {
  // A model in the maker's own API is one a reader can call this minute; weights are one they can
  // run if they have the hardware; a reseller's catalogue is the same news arriving second-hand.
  if (event.stream === "api-models") return 4;
  if (event.stream === "weights") return 3;
  if (event.stream === "resets" || event.stream === "apps") return 1;
  if (event.stream === "openrouter") return 1;
  return 2;
}

/**
 * A tier of something else, named without the catalogue's usual brackets.
 *
 * `MiniMax M3 Fast`, `GLM 5.3 Fast` and `Jev 1.13 Free` are prices for a model rather than models,
 * and they arrive as plain names. `Grok 4 Fast` is a model whose name ends the same way, so the
 * word alone cannot decide: this returns what the entry would be a tier of, and the caller drops it
 * only when that thing is one it has already seen.
 */
/**
 * A modality of a family, named by the catalogue as a suffix on the family's name.
 *
 * `Gemini 3.8 Flash TTS` is the speech head of a model published in August, and `Supra2 IMG` is the
 * image one. They are real endpoints and neither is a release: the 20-27 September recap gave
 * Google's only line to a TTS variant while Gemini 3.9 Flash, the actual release, was not in the
 * message at all. Like a tier, this only folds away when the family itself is something we have
 * already seen -- a maker whose one product is an ASR model is not publishing a variant of
 * anything.
 */
const MODALITY_WORD =
  /[\s:_-](tts|stt|asr|ocr|img|image|vision|audio|voice|speech|transcribe|embed|embedding|rerank|reranker)$/i;
export function modalityBase(name: string): string | null {
  const trimmed = name.trim();
  return MODALITY_WORD.test(trimmed) ? modelSubject(trimmed.replace(MODALITY_WORD, "")) : null;
}

/**
 * A model that answers in something other than text.
 *
 * This feed is read for what it can be coded against, and a model that returns a picture, a clip or
 * a vector is a different craft however large it is. `modalityBase` already folds a modality head
 * into the family it belongs to, but only as a trailing word and only once the family is in hand:
 * `Grok Imagine Video 1.5 Lite` carries the word in the middle, is the whole of xAI's week, and
 * reached the 27 September card as one of five models because nothing here asked what it returns.
 *
 * Two readings, because neither covers the other. A catalogue that publishes output modalities has
 * settled the question -- but only openrouter and the mirrors publish them as a list, models.dev
 * spells `output` as a token ceiling, and xAI's own API says nothing at all. So the name answers
 * when the record does not, and silence on both means text: the overwhelming majority of rows carry
 * no modalities, and a gate that read silence as doubt would empty the feed.
 */
const ANOTHER_MODALITY =
  /(?:^|[\s:_/-])(tts|stt|asr|ocr|img|image|imagine|vision|audio|voice|speech|transcribe|video|diffusion|embed|embedding|rerank|reranker)(?:$|[\s:_/-])/i;
export function servesAnotherModality(name: string, record?: RecordData | null): boolean {
  const output = record?.output;
  // Only a list is a list of modalities. `output: 128000` is models.dev spelling a token ceiling
  // into the same field, and reading it as a modality calls every model it lists a picture.
  if (Array.isArray(output) && output.length > 0) {
    return !output.some((modality) => String(modality).toLowerCase() === "text");
  }
  return ANOTHER_MODALITY.test(name.trim());
}

/**
 * Something published to measure models rather than to be one.
 *
 * A watched organisation's new repository is read as that lab's new model, which is the whole point
 * of watching it -- and InternLM published `AdvancedMathBench-AutoVerifier` on 29 September, a
 * grader for a benchmark, which took a line on the week's card with the authority of a first-party
 * release. The organisations worth watching are exactly the ones that also publish the evaluations,
 * so this is not a rare shape.
 */
const AN_EVALUATION =
  /(?:^|[\s:_/-])(bench|benchmark|autoverifier|verifier|eval|evals|evaluation|dataset|leaderboard|testbed|arena)(?:$|[\s:_/-])|bench(?:mark)?[-_]?(?:v?\d|suite|auto)/i;
export function isAnEvaluation(name: string): boolean {
  return AN_EVALUATION.test(name.trim());
}

/**
 * The same weights at a different precision, which a lab publishes beside the release.
 *
 * Aleph-Alpha shipped `Kolibri-1`, `Kolibri-1-BF16` and `Kolibri-1-FP8` into one organisation on
 * one morning. `isRepublished` already covers somebody else's quantisation of another lab's model;
 * this is the lab's own, where the handle matches and nothing marks it as derived. Like a tier, it
 * only folds away once the model it is a precision of is in hand -- a lab whose only published
 * artefact is an FP8 build has still published something.
 */
const PRECISION_WORD = /[\s:_-](bf16|fp16|fp8|fp4|nvfp4|int[48]|w[48]a\d+|gguf|gptq|awq|mlx|bnb|\d-?bit)$/i;
export function precisionBase(name: string): string | null {
  const trimmed = name.trim();
  return PRECISION_WORD.test(trimmed) ? modelSubject(trimmed.replace(PRECISION_WORD, "")) : null;
}

/**
 * Something a catalogue serves that is not a model at all.
 *
 * `TypeSafe: Jev Router` picks a model per request; it has a row, a price and no weights. A recap
 * that counts it is counting the catalogue's plumbing.
 */
const NOT_A_MODEL = /[\s:_-](router|gateway|proxy)$/i;
export function isNotAModel(name: string): boolean {
  return NOT_A_MODEL.test(name.trim());
}

const TIER_WORD =
  /[\s:-](fast|free|flex|batch|lite|turbo|cheap|standard|pro|prime|ultraspeed|ultra[\s-]speed|realtime|real[\s-]time)$/i;
export function tierBase(name: string): string | null {
  const trimmed = name.trim();
  return TIER_WORD.test(trimmed) ? modelSubject(trimmed.replace(TIER_WORD, "")) : null;
}

export type CataloguedArrival = { name: string; reseller: string; maker: string };

/**
 * A name with the catalogue's date on it taken off, for a line a reader reads.
 *
 * `MAI-Image-2e-2026-04-09` reached the digest as "MAI Image 2e 2026 04 09" on 2026-09-22, which is
 * a deployment date read as part of a model's name. The date is how the catalogue tells one build of
 * a model from another; it is never what the model is called.
 */
function withoutSnapshotDate(name: string): string {
  return name.trim().replace(DATED_SNAPSHOT, "");
}

/**
 * One line per model, rather than one line per row a catalogue wrote about it.
 *
 * TrueFoundry listed MAI Image 2.6 on 2026-09-25 as four entries -- the model, a dated snapshot of
 * it, its Flash tier and a dated snapshot of that -- and the day's digest spent five of its eight
 * lines on one catalogue restating itself. `modelSubject` already knows those are one release seen
 * several ways; this is that knowledge applied to a list of arrivals.
 *
 * A second shop listing the same model is not a variant of it: Ember 1 reached the Vercel gateway
 * and OpenRouter the same day and read as two launches by one maker. So the extra rows are counted
 * against the shops -- one row per shop is the model arriving there, and anything beyond that is
 * the catalogue's own bookkeeping, said as a count rather than repeated as a name.
 *
 * The name kept is the one the catalogue wrote plainest: a row that is not a variant if there is
 * one, then the shortest, so a group is never named by its dated snapshot.
 */
export function oneLinePerModel(
  rows: readonly CataloguedArrival[],
): (CataloguedArrival & { alsoOn: string[]; variants: number })[] {
  const groups = new Map<string, CataloguedArrival[]>();
  for (const row of rows) {
    const key = modelSubject(row.name) || normalizeIdentity(row.name);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((group) => {
    const named = [...group].sort(
      (left, right) =>
        Number(isModelVariant(left.name)) - Number(isModelVariant(right.name)) ||
        left.name.length - right.name.length ||
        left.name.localeCompare(right.name),
    );
    const resellers = [...new Set(group.map((row) => row.reseller))];
    const first = named[0] as CataloguedArrival;
    return {
      ...first,
      name: withoutSnapshotDate(first.name),
      // The shop that named it plainest leads, and the others follow in the order they were read.
      reseller: first.reseller,
      alsoOn: resellers.filter((reseller) => reseller !== first.reseller),
      variants: group.length - resellers.length,
    };
  });
}
