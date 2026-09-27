/**
 * Weights in a registry, which are the earliest word on a model and the furthest from using one.
 *
 * A repository beside a release, a router picking up weights published months ago, and a trending
 * list of models that are already out: all three are Hugging Face saying something happened that
 * had already happened.
 */
import { recordFor } from "./record.js";
import type { Event } from "./types.js";
import { isBesideTheRelease } from "./variants.js";

/**
 * Weights a followed lab published that declare nothing to run.
 *
 * `tencent/WeVisDoc-2B` and `-4B` reached the invited room on 2026-09-17 with no pipeline, no
 * downloads and a document-retrieval purpose nobody there came for. The recap already left such
 * repositories out; the cards did not.
 */
export function isWeightsBesideTheRelease(event: Event): boolean {
  return event.kind === "new" && event.source.startsWith("huggingface:") && isBesideTheRelease(recordFor(event));
}

/**
 * A router starting to serve weights that were published long ago.
 *
 * `zai-org/GLM-4.7-FP8` arrived on Hugging Face's inference router on 2026-09-17 as it dropped
 * `GLM-4.6-FP8`; the repository dates from 2025-12-22. A sighting is the earliest word on a model,
 * and this one was months late.
 */
const LONG_PUBLISHED_MS = 30 * 24 * 3_600_000;

export function isLongPublishedWeights(event: Event): boolean {
  if (event.kind !== "new" || event.source !== "huggingface-router") return false;
  const created = Date.parse(String(recordFor(event)?.created ?? ""));
  return Number.isFinite(created) && Date.parse(event.detected_at) - created > LONG_PUBLISHED_MS;
}

/**
 * A repository trending on Hugging Face from a lab nobody follows here.
 *
 * Trending lists open models that are already out, which is the opposite of a sighting; a followed
 * lab's own weights are told from its organisation first. `Cactus-Compute/needle3` reached the
 * scouts on 2026-09-18, two days after it was published. A lab worth hearing from is followed.
 */
export function isTrendingFromAnUnfollowedLab(event: Event): boolean {
  return event.kind === "new" && event.source.startsWith("discovery:huggingface");
}
