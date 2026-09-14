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
const VARIANT_SUFFIX = /\((batch|free|beta|preview|alpha|experimental|self[- ]moderated|extended|thinking)\)\s*$/i;
const ALIAS_SUFFIX = /[:\s-](latest|preview)$/i;
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
  /[-_.\s](sft|rl|rlhf|dpo|ppo|grpo|rm|reward|base|pretrain|lora|adapter|checkpoint|ckpt|distill|distilled)$/i;

/** True when this entry is another way of selling a model the catalogue already lists. */
export function isModelVariant(name: string): boolean {
  const trimmed = name.trim();
  return (
    VARIANT_SUFFIX.test(trimmed) ||
    ALIAS_SUFFIX.test(trimmed) ||
    DATED_SNAPSHOT.test(trimmed) ||
    DUPLICATE_ROW.test(trimmed)
  );
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
    .replace(DATED_SNAPSHOT, "")
    .replace(/\s*\(\d+\)\s*$/, "")
    .replace(/^[^:/]+[:/]/, "");
  return normalizeIdentity(stripped) || normalizeIdentity(name);
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
