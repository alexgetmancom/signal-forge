import type { Database } from "bun:sqlite";
import { listedInCatalogue, olderThanKnown } from "../sources/mentionStage.js";
import { isLearnedMaker } from "./breakouts.js";
import { recordFor } from "./record.js";
import {
  isUnfollowedMakerAtAReseller,
  resellerMaker,
  type SignalClass,
  sellsAnotherMakersModel,
  signalClass,
} from "./signals.js";
import type { Event } from "./types.js";

/**
 * The class an event is routed by, decided once, when it is stored, and kept on the row.
 *
 * `signalClass` reads the event alone. The rules here need to know what else is in the database, and
 * until 2026-09-21 they lived in the store's routing only: the reports re-ran `signalClass` and
 * counted a late docs page as a sighting the channel never received. One function, run once, whose
 * answer the reports read back, keeps what was counted and what was sent the same thing.
 */
export function classify(db: Database, event: Event): SignalClass {
  // A small company whose model took off here is followed from then on: its next arrival at a
  // reseller is a sighting on arrival, not a line in tomorrow's recap.
  if (isUnfollowedMakerAtAReseller(event) && isLearnedMaker(db, resellerMaker(event))) return "codename";
  const signal = signalClass(event);
  if (signal === "codename" && (launchedAlready(db, event) || servingModeOfKnownModel(db, event))) return "evidence";
  if (signal === "change" && supersededModel(db, event) && !movesWhatAReaderActsOn(event)) return "evidence";
  if (signal === "change" && sideRepricingAtReseller(event)) return "evidence";
  return signal;
}

/**
 * A sighting of a model a catalogue already sells is late. xAI's `grok-4-7` docs page reached the
 * scouts on 2026-09-21 twenty-six minutes after Grok 4.7 reached the public channel from the API:
 * the scouts' channel is for what is coming, and this had come.
 */
function launchedAlready(db: Database, event: Event): boolean {
  if (event.stream !== "pages" || event.kind !== "new") return false;
  const slug = event.entity_id.split("?")[0]?.replace(/\/+$/, "").split("/").at(-1) ?? "";
  return /\d/.test(slug) && listedInCatalogue(db, slug);
}

/**
 * A mode of a model a reseller already sells is not a model. `glm-5.3-prime` reached the scouts as
 * new on 2026-09-21: Model Studio's "Prime mode" is a faster serving of `glm-5.3`, as
 * `glm-5.2-fast-preview` is of `glm-5.2`. Only when the base is listed: `grok-4-fast` was a model of
 * its own, and a `-fast` whose base nobody sells yet is the first word on both.
 */
const SERVING_MODE = /-(?:prime|fast)(?:-preview)?$/i;
function servingModeOfKnownModel(db: Database, event: Event): boolean {
  if (!["api-models", "openrouter"].includes(event.stream) || event.kind !== "new") return false;
  if (!SERVING_MODE.test(event.entity_id)) return false;
  return listedInCatalogue(db, event.entity_id.replace(SERVING_MODE, ""));
}

/**
 * A number moving on a model its family has moved past is housekeeping. Claude Sonnet 4's context
 * on OpenRouter falling from 1M to 200K reached the public channel on 2026-09-21, a model retired
 * in June while Sonnet 4.6 is listed beside it; nobody reading chooses Sonnet 4 today.
 */
function supersededModel(db: Database, event: Event): boolean {
  if (!["api-models", "openrouter"].includes(event.stream) || event.kind !== "changed") return false;
  return olderThanKnown(db, event.entity_id.toLowerCase());
}

/**
 * What still travels on an old model: its price, which is why people stay on one, and the date it
 * goes away, which they have to act on.
 */
const ACTED_ON = ["pricing", "deprecation", "deprecated", "retirement", "retires", "expiration_date", "sunset"];
function movesWhatAReaderActsOn(event: Event): boolean {
  const before = event.before_json ? (JSON.parse(event.before_json) as Record<string, unknown>) : {};
  const after: Record<string, unknown> = recordFor(event) ?? {};
  return ACTED_ON.some((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
}

/**
 * A reseller moving a rate nobody chooses a model by is its own bookkeeping. The Vercel AI Gateway
 * cutting DeepSeek V4.1 Flash's cache read from $0.03 to $0.007 and redrawing its regional sheet
 * reached the public channel on 2026-09-21 as a price card; the input and output prices had not
 * moved. OpenRouter is the catalogue people price models by, and a maker's own sheet is the price.
 */
const RATES = ["prompt", "completion", "input", "output"];
function sideRepricingAtReseller(event: Event): boolean {
  if (event.kind !== "changed" || event.source === "openrouter" || !sellsAnotherMakersModel(event)) return false;
  const before = event.before_json ? (JSON.parse(event.before_json) as Record<string, unknown>) : {};
  const after: Record<string, unknown> = recordFor(event) ?? {};
  const moved = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  if (!moved.length || moved.some((key) => key !== "pricing")) return false;
  const rates = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
  const old = rates(before.pricing);
  const next = rates(after.pricing);
  // A small step in the rates themselves is the threshold's to judge, as on any catalogue.
  return RATES.every((key) => JSON.stringify(old[key]) === JSON.stringify(next[key]));
}

/** The class an event was routed by: kept on the row, or the event-only rule for older rows. */
export function signalOf(event: Event): SignalClass {
  return (event.signal as SignalClass | null | undefined) ?? signalClass(event);
}
