import { readableName } from "../events/naming.js";
import { ANNOUNCEMENT_STREAMS } from "../events/signals.js";
import type { Event, RecordData } from "../events/types.js";
import {
  arrivalWeight,
  isBesideTheRelease,
  isModelVariant,
  isRepublished,
  isTrainingArtefact,
  modelSubject,
  tierBase,
} from "../events/variants.js";
import { vendorOf, vendorOfName } from "../events/vendors.js";
import { nameOf, type PeriodReading, recordOf } from "./reading.js";
import type { RecapContext } from "./schema.js";

export const ARRIVAL_GROUPS = 6;

function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CATALOGUE_STREAMS = new Set(["api-models", "openrouter", "weights"]);

/**
 * Is this arrival a model, or another way of listing one?
 *
 * A batch tier, a free tier, a `latest` alias, a dated snapshot and somebody else's quantisation
 * are all real records and none of them is a release. Counting them is how the first recap reported
 * thirty-seven models in a week that had nine, and led with a batch tier of a model from July.
 */
function isRealArrival(event: Event, renamed: Set<number>): boolean {
  const record = recordOf(event);
  const name = String(record?.name ?? event.entity_id);
  if (renamed.has(event.id)) return false;
  // Only a stream that lists models can say a model arrived. `launch` is a class about what a
  // reader wants to hear now, and a severe outage, a changelog headline and a credit notice all
  // earn it: "Elevated errors affecting ChatGPT Work mode" and "Codex banked reset credit
  // announced" were both counted among the week's 53 models.
  if (!CATALOGUE_STREAMS.has(event.stream)) return false;
  // Only a registry says what an artefact is; a catalogue row is a model by construction.
  if (event.stream === "weights" && isBesideTheRelease(record)) return false;
  // A reseller's catalogue gains rows faster than the field gains models, and most of them are
  // narrow developer tools: Inference.net's Schematron is a 3B model that turns HTML into JSON,
  // which is a useful thing and not a week's news for anyone who is not parsing websites. Nothing
  // else we collect has ever heard of it -- no benchmark, no arena, no maker's API -- so the only
  // judgement available is whether the maker is one this tracker follows. Adding a maker to that
  // table is how a new name gets in, and it is one line.
  if (event.stream === "openrouter" && vendorOf(event, record) === "Unknown") return false;
  return !isModelVariant(name) && !isTrainingArtefact(name) && !isRepublished(event, record);
}

/**
 * Who a reader would say published this.
 *
 * The maker table answers for anything it recognises. Everything else names itself in the shape of
 * its own handle -- `Sakana: Fugu Max` from a catalogue, `google/gnm-v3` from a registry -- and
 * reading that is better than filing a real launch under "Other" because the maker is new.
 */
function arrivalVendor(event: Event, record: RecordData | null, name: string): string {
  const known = vendorOf(event, record);
  if (known !== "Unknown") return known;
  const labelled = /^([^:]{2,30}):\s/.exec(name);
  if (labelled?.[1]) return labelled[1];
  const id = String(record?.id ?? event.entity_id);
  const namespace = id.includes("/") ? (id.split("/")[0] ?? "") : "";
  return namespace || "Other";
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
  // What anything had already named before the period began. A catalogue listing a model is not
  // the model arriving: OpenRouter carried GLM 5.2 and GLM 5.3 on 8 September and OpenAI's own API
  // carried gpt-live-1 on the 10th, and all three were reported as this week's arrivals because a
  // second catalogue caught up inside the week. The first time anything names it is the week it
  // arrived, and every week after that it is furniture.
  const alreadyNamed = new Set(
    db
      .query<{ name: string }, [string]>(
        "SELECT COALESCE(json_extract(after_json,'$.name'), entity_id) AS name FROM events WHERE detected_at<?",
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
  for (const { event, signal } of classified) {
    // A week is read for what arrived, which is a wider question than what was worth interrupting
    // a reader for. A reseller listing a model is a sighting rather than a launch and never
    // reaches the public channel on its own, but it is still the week's first word that the model
    // exists, and the weighting below already prefers the maker's own word over a reseller's.
    const arrived = signal === "launch" || signal === "codename";
    if (!arrived || event.kind !== "new" || !isRealArrival(event, renamed)) continue;
    const record = recordOf(event);
    // A catalogue adding a row is not a model being born. Groq listed Compound Mini and OpenRouter
    // re-listed gpt-oss inside one week, and the week read as though GPT-OSS had just come out. The
    // registry's own date settles it: dated before the week, it is a listing, not an arrival.
    const created = Date.parse(String(record?.created ?? ""));
    if (Number.isFinite(created) && created < Date.parse(from)) continue;
    const name = nameOf(event);
    const subject = modelSubject(name);
    if (alreadyNamed.has(subject)) continue;
    // Dated to this period by a catalogue, or named in something a maker published in it. A
    // catalogue row with no date behind it says only that the catalogue has the model today.
    const readable = readableName(name).toLowerCase();
    if (!datedThisPeriod.has(subject) && !(readable.length >= 5 && announced.includes(readable))) continue;
    // A tier is not a model. "MiniMax M3 Fast" and "Jev 1.13 Free" are ways of billing something
    // already here, and only the catalogue's own words say so -- so the trailing word only folds
    // away when the thing it is a tier of is something we have seen.
    const base = tierBase(name);
    if (base && (alreadyNamed.has(base) || bySubject.has(base))) continue;
    const weight = arrivalWeight(event);
    const held = bySubject.get(subject);
    if (!held || weight > held.weight)
      bySubject.set(subject, { name, vendor: arrivalVendor(event, record, name), weight });
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
  const arrivals = [...byVendor.entries()].map(([vendor, names]) => ({ vendor, names }));
  return {
    arrivals,
    arrivalCount: ranked.length,
    arrived: new Set([...bySubject.values()].map((arrival) => modelSubject(arrival.name))),
  };
}
