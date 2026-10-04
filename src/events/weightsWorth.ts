/**
 * Weights in a registry, which are the earliest word on a model and the furthest from using one.
 *
 * A repository beside a release and a trending list of models that are already out: both are
 * Hugging Face saying something happened that had already happened. The third of them -- weights
 * published long before we read them -- moved to releaseDate.ts, because it turned out to be a
 * question about any catalogue rather than about this one.
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
 * A repository trending on Hugging Face from a lab nobody follows here.
 *
 * Trending lists open models that are already out, which is the opposite of a sighting; a followed
 * lab's own weights are told from its organisation first. `Cactus-Compute/needle3` reached the
 * scouts on 2026-09-18, two days after it was published. A lab worth hearing from is followed.
 */
export function isTrendingFromAnUnfollowedLab(event: Event): boolean {
  return event.kind === "new" && event.source.startsWith("discovery:huggingface");
}
