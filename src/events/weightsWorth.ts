/**
 * Weights in a registry, which are the earliest word on a model and the furthest from using one.
 *
 * A repository beside a release, a reading that finds weights published months ago, and a trending
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
 * Weights read here for the first time that were published long ago.
 *
 * Asked of every Hugging Face reading, because both of them can see a repository late and neither
 * can see one early. The router starts serving weights that already existed: `zai-org/GLM-4.7-FP8`
 * arrived on 2026-09-17 as it dropped `GLM-4.6-FP8`, and the repository dates from 2025-12-22. An
 * organisation's listing does the same whenever the window onto it widens, which is not a rare
 * event -- it is every author added to `HF_AUTHORS` and every sort order added beside `createdAt`.
 * Reading a second listing by `lastModified` cost 25 cards on 2026-10-04, `microsoft/phi-4` among
 * them, published 2024-12-11 and announced as new on the first poll that could see it.
 *
 * `created` is the repository's own date, so the rule does not depend on which listing found it or
 * on when this deployment started asking. A sighting is the earliest word on a model; a month after
 * publication nothing here is the earliest word on anything.
 */
const LONG_PUBLISHED_MS = 30 * 24 * 3_600_000;

export function isLongPublishedWeights(event: Event): boolean {
  if (event.kind !== "new") return false;
  if (event.source !== "huggingface-router" && !event.source.startsWith("huggingface:")) return false;
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
