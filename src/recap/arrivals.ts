import { becameReachable, CATALOGUE_STREAMS, reachableListingSql, unreachableBecause } from "../events/availability.js";
import { signalOf } from "../events/classify.js";
import { readableName } from "../events/naming.js";
import { isAnUnfollowedMakersWeights } from "../events/resellers.js";
import { ANNOUNCEMENT_STREAMS, CODING_TOOL_SOURCES } from "../events/signals.js";
import type { Event } from "../events/types.js";
import {
  arrivalWeight,
  isAnEvaluation,
  isBesideTheRelease,
  isModelVariant,
  isNotAModel,
  isRepublished,
  isTrainingArtefact,
  modalityBase,
  modelSubject,
  precisionBase,
  servesAnotherModality,
  tierBase,
} from "../events/variants.js";
import { vendorOf, vendorOfName, vendorRank } from "../events/vendors.js";
import { nameOf, type PeriodReading, recordOf } from "./reading.js";
import type { RecapContext } from "./schema.js";

export const ARRIVAL_GROUPS = 6;

function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does something a maker published name this model?
 *
 * Both sides are read with their separators loosened, because a maker writes `DeepSeek-V4.1-Flash`
 * where `readableName` writes `DeepSeek V4.1 Flash`, and a comparison that loosened only the
 * model's side rejected DeepSeek's own announcement of its own model 15 minutes after the weights.
 * The word boundary stays, or a substring dates the wrong model: xAI's "Grok Voice Transcribe 2.0"
 * is not a word about Grok Voice, and "GLM 5.3" is not a word about GLM 5.
 */
function namesModel(announced: string, readable: string): boolean {
  if (readable.length < 5) return false;
  const pattern = readable
    .split(/[\s\-_]+/)
    .filter(Boolean)
    .map(escapeForPattern)
    .join("[\\s\\-_]+");
  return new RegExp(`(?<!\\w)(?<!\\d\\.)${pattern}(?!\\w)(?!\\.\\d)`, "i").test(announced);
}

/**
 * Which rule says this arrival is not a model, or null when none of them does.
 *
 * The name of the rule and not a boolean, because the question an operator arrives with is never
 * "is this an arrival" but "why was this not in the week". `trace` prints what this returns, which
 * is why the reasons are named rather than counted: before this, answering why one model was absent
 * meant reading this file and comparing its rules against a record by eye, and there are more of
 * them every month -- modality, evaluation, precision, the coding-tool lift.
 *
 * A batch tier, a free tier, a `latest` alias, a dated snapshot and somebody else's quantisation
 * are all real records and none of them is a release. Counting them is how the first recap reported
 * thirty-seven models in a week that had nine, and led with a batch tier of a model from July.
 */
export function arrivalRejection(event: Event, renamed: Set<number>): string | null {
  const record = recordOf(event);
  const name = String(record?.name ?? event.entity_id);
  if (renamed.has(event.id)) return "renamed_by_the_source";
  /**
   * A week is read for what arrived, which is a wider question than what was worth interrupting a
   * reader for. A reseller listing a model is a sighting rather than a launch and never reaches the
   * public channel on its own, but it is still the week's first word that the model exists, and the
   * weighting downstream already prefers the maker's own word over a reseller's.
   */
  /**
   * A listing that opened this period is an arrival however the catalogue spells the edit: see
   * `becameReachable`. It passes the two gates below because it fails both -- the change is classed
   * `change` and the row is `changed` -- and it is the one week a reader can act on the model.
   */
  const opened = becameReachable(event);
  if (!opened) {
    const signal = signalOf(event);
    // Weights from a maker nobody here follows are `evidence` on purpose, so that the radar is not
    // told about NVIDIA's next checkpoint; the week it was published is still the week it arrived,
    // which is the same argument the paragraph above makes for a reseller's listing.
    if (signal !== "launch" && signal !== "codename" && !isAnUnfollowedMakersWeights(event))
      return "neither_a_launch_nor_a_sighting";
    // A catalogue rewriting a row it already had is the catalogue repeating itself.
    if (event.kind !== "new") return "not_a_record_arriving";
  }
  // Only a stream that lists models can say a model arrived. `launch` is a class about what a
  // reader wants to hear now, and a severe outage, a changelog headline and a credit notice all
  // earn it: "Elevated errors affecting ChatGPT Work mode" and "Codex banked reset credit
  // announced" were both counted among the week's 53 models.
  if (!CATALOGUE_STREAMS.has(event.stream)) return "not_a_stream_that_lists_models";
  // Only a registry says what an artefact is; a catalogue row is a model by construction.
  if (event.stream === "weights" && isBesideTheRelease(record)) return "published_beside_the_release";
  /**
   * A listing whose own words say nobody outside the maker can call it yet. Held rather than
   * discarded: `alreadyArrived` below counts arrivals and not mentions, so the week the listing
   * opens is the week this model is reported, which is the week a reader can act on it.
   */
  const unreachable = unreachableBecause(event.stream, record);
  if (unreachable) return `nobody_can_call_it_yet:${unreachable}`;
  // A reseller's catalogue gains rows faster than the field gains models, and a registry gains
  // them faster still: `well9472/Nanosaur2-670M`, `paradigma-inc/Limite-1b-Violetto` and
  // `Kijai/Ming-Image-ComfyUI` were three of the twelve the 20-27 September recap called "smaller
  // makers", and the maker it named for each was the handle that published it. Nothing else we
  // collect has ever heard of them -- no benchmark, no arena, no maker's API -- so the only
  // judgement available is whether the maker is one this tracker follows. Adding a maker to that
  // table is how a new name gets in, and it is one line.
  // -- unless a coding tool has already put it in front of the reader, which answers the same
  // question the maker's name was standing in for: can this be used, and for this.
  if (vendorOf(event, record) === "Unknown" && !CODING_TOOL_SOURCES.has(event.source))
    return "a_maker_this_tracker_does_not_follow";
  // What this feed is read for. A model that returns a picture, a clip or a vector is a different
  // craft, and the reader cannot code against it however large the maker is: Grok Imagine Video
  // 1.5 Lite was one of the five models on the 27 September card and was nobody's news here.
  if (servesAnotherModality(name, record)) return "serves_another_modality";
  // A grader is not a release. `internlm/AdvancedMathBench-AutoVerifier` took a line on that same
  // card, with the authority of a watched lab publishing to its own organisation.
  if (isAnEvaluation(name)) return "an_evaluation_rather_than_a_model";
  if (isModelVariant(name)) return "a_variant_of_a_model";
  if (isTrainingArtefact(name)) return "a_training_artefact";
  if (isNotAModel(name)) return "not_a_model_at_all";
  if (isRepublished(event, record)) return "republished_from_elsewhere";
  return null;
}

/**
 * What arrived, grouped by maker, and the subjects those arrivals are about.
 *
 * The subjects come back with them because a name this period reports as arrived is not also a name
 * it reports as retiring.
 */
export function periodArrivals(reading: PeriodReading): {
  arrivals: RecapContext["arrivals"];
  arrivalCount: number;
  arrived: Set<string>;
} {
  const { db, from, to, classified, renamed } = reading;
  const events = classified.map(({ event }) => event);
  /**
   * What had already arrived before the period began -- and arrived, not merely been mentioned.
   *
   * A catalogue listing a model is not the model arriving twice: OpenRouter carried GLM 5.2 and GLM
   * 5.3 on 8 September and OpenAI's own API carried gpt-live-1 on the 10th, and all three were
   * reported as a later week's arrivals because a second catalogue caught up inside it. The first
   * time a catalogue serves it is the week it arrived, and every week after that it is furniture.
   *
   * Counted over the catalogue streams alone, because a mention is not an arrival and a model held
   * back for a week has to be able to come back. Gemini 4 Argon was announced on 2026-09-30 and
   * served by nobody; read as "already named", the week it opened could never report it, which is
   * the one week a reader could do anything about it.
   *
   * What this gives up, measured on the two weeks to 20 and 27 September: Command A+ becomes an
   * arrival of the second one. Cohere shipped it in May, OpenRouter listed it on 22 September with
   * its own listing date as `created`, and the only earlier word anywhere here was a board placing
   * on the 19th -- one day before the week. Read over every mention, that board row excluded it; read
   * over listings, nothing does. That exclusion was luck rather than a rule: a placing on the 21st
   * would have let it through either way, and the rule that actually knows this one is
   * `known_here_for_weeks` on the delivery path, which asks how long we have followed the subject
   * rather than whether anything ever said its name.
   *
   * Any event of those streams and not only an arriving one: a catalogue that has carried a model
   * since before we arrived produces nothing but `changed` rows about it, and read as arrivals alone
   * this reported Kimi K3, listed on OpenRouter since 11 September and created in July, as an
   * arrival of the week to 20 September. A listing that nobody could call is not counted, which is
   * the whole point of the narrowing: that is the row the week after it opens has to be able to see.
   */
  const alreadyNamed = new Set(
    db
      .query<{ name: string }, [string]>(
        `SELECT COALESCE(json_extract(after_json,'$.name'), entity_id) AS name FROM events
          WHERE detected_at<?
            AND stream IN (${[...CATALOGUE_STREAMS].map((stream) => `'${stream}'`).join(",")})
            AND ${reachableListingSql("after_json")}`,
      )
      .all(from)
      .map((row) => modelSubject(String(row.name ?? ""))),
  );
  // Something has to date a model to this week before the week claims it. Our own history is the
  // weakest possible evidence -- it begins when this tracker did, so everything older than that
  // looks new the first time a catalogue mentions it, and MiniMax M2.7, published in March, was
  // reported as an arrival of 15 September. Two things can date a model: a catalogue publishing a
  // creation date inside the period, or the maker announcing it by name inside the period.
  const datedThisPeriod = new Set(
    events
      .filter((event) => {
        // A listing opening is dated by the change this deployment watched happen, which is the one
        // date about availability that does not depend on when we arrived.
        if (becameReachable(event)) return true;
        const created = Date.parse(String(recordOf(event)?.created ?? ""));
        return Number.isFinite(created) && created >= Date.parse(from) && created < Date.parse(to);
      })
      .map((event) => modelSubject(nameOf(event))),
  );
  // Everything the makers themselves published this period, as one body of text. "Introducing
  // Gemini 3.8 Live and 3.8 Live Extended Thinking" dates both models no catalogue dated, and the
  // whole name has to appear: xAI's "Grok Voice Transcribe 2.0" is not a word about Grok Voice STT.
  const announced = ANNOUNCEMENT_STREAMS.size
    ? classified
        .filter(({ event }) => ANNOUNCEMENT_STREAMS.has(event.stream))
        .map(({ event }) => nameOf(event).toLowerCase())
        .join("\n")
    : "";
  // One model however many collectors saw it, and the maker's own word ahead of a reseller's.
  const bySubject = new Map<string, { name: string; vendor: string; weight: number }>();
  for (const { event } of classified) {
    if (arrivalRejection(event, renamed)) continue;
    const record = recordOf(event);
    // A catalogue adding a row is not a model being born. Groq listed Compound Mini and OpenRouter
    // re-listed gpt-oss inside one week, and the week read as though GPT-OSS had just come out. The
    // registry's own date settles it: dated before the week, it is a listing, not an arrival.
    // Unless the week's news is the listing opening: a catalogue that opens a model to everybody
    // keeps the date it first wrote the row, and that date is older than the week by construction.
    const created = Date.parse(String(record?.created ?? ""));
    if (!becameReachable(event) && Number.isFinite(created) && created < Date.parse(from)) continue;
    const name = nameOf(event);
    const subject = modelSubject(name);
    if (alreadyNamed.has(subject)) continue;
    // Dated to this period by a catalogue, or named in something a maker published in it. A
    // catalogue row with no date behind it says only that the catalogue has the model today.
    if (!datedThisPeriod.has(subject) && !namesModel(announced, readableName(name))) continue;
    // A tier is not a model. "MiniMax M3 Fast" and "Jev 1.13 Free" are ways of billing something
    // already here, and only the catalogue's own words say so -- so the trailing word only folds
    // away when the thing it is a tier of is something we have seen. A tier of something named
    // before this week folds away here; a tier of something arriving in the same week is folded
    // in the pass below, because whether the base is in hand depends on collection order and
    // "GPT-6 Luna Pro" led the week's OpenAI line ahead of GPT-6 Luna itself.
    const base = tierBase(name) ?? modalityBase(name) ?? precisionBase(name);
    if (base && alreadyNamed.has(base)) continue;
    const weight = arrivalWeight(event);
    const held = bySubject.get(subject);
    if (!held || weight > held.weight) bySubject.set(subject, { name, vendor: vendorOf(event, record), weight });
  }
  // A tier of a model that arrived in the same week, now that the whole week is in hand. Xiaomi
  // shipped MiMo V2.6 Pro and MiMo V2.6 Pro UltraSpeed on one morning -- one checkpoint at two
  // speeds and two prices -- and OpenRouter carried "GPT-6 Luna Pro" for a model OpenAI announced
  // as GPT-6 Luna. Four of the week's twenty-six names were the same four models said twice.
  for (const [subject, arrival] of [...bySubject]) {
    const base = tierBase(arrival.name) ?? modalityBase(arrival.name) ?? precisionBase(arrival.name);
    if (base && base !== subject && bySubject.has(base)) bySubject.delete(subject);
  }
  // Weight first, then a maker a reader has heard of: a research artefact published as weights
  // outranks a catalogue row on paper and is not what the week was about.
  const ranked = [...bySubject.values()].sort(
    (one, other) =>
      other.weight - one.weight ||
      Number(vendorOfName(other.name) !== "Unknown") - Number(vendorOfName(one.name) !== "Unknown"),
  );
  // Grouped by maker, because that is the shape of the question a reader is asking. Eight names in
  // a row says a week happened; "OpenAI three, DeepSeek one" says what happened in it.
  const byVendor = new Map<string, string[]>();
  for (const arrival of ranked) {
    const names = byVendor.get(arrival.vendor) ?? [];
    // The maker's name is already the heading; repeating it inside every entry is noise.
    names.push(readableName(arrival.name).replace(new RegExp(`^${escapeForPattern(arrival.vendor)}:\\s*`, "i"), ""));
    byVendor.set(arrival.vendor, names);
  }
  // The three makers this feed's readers pay for come first, in that order, and everything else
  // keeps the order the weighting above gave it. The list is cut to six groups downstream, so an
  // ordering that buried Google behind a billing tier did not reorder the message -- it removed
  // Google from it.
  const arrivals = [...byVendor.entries()]
    .map(([vendor, names]) => ({ vendor, names }))
    .sort((one, other) => vendorRank(one.vendor) - vendorRank(other.vendor));
  return {
    arrivals,
    arrivalCount: ranked.length,
    arrived: new Set([...bySubject.values()].map((arrival) => modelSubject(arrival.name))),
  };
}
