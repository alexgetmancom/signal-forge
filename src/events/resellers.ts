/**
 * Who is selling the model, which is what tells a launch from a listing.
 *
 * A maker's own catalogue shipping its own model is the launch; a platform listing somebody else's
 * is a sighting, a stealth row with no maker on it and no price is a launch wherever it appears,
 * and a known lab this reader will never call is a line in the morning. `catalogueClass` asks those
 * in order for every api-models, openrouter and weights row.
 */
import { text } from "../text.js";
import { recordFor } from "./record.js";
import { isAJobThisReaderDidNotComeFor, isAMakerThisReaderDoesNotFollow } from "./subject.js";
import type { Event, RecordData, SignalClass } from "./types.js";
import { vendorOfName } from "./vendors.js";

/**
 * The maker whose own models an API catalogue sells. A catalogue absent here sells other makers'
 * models -- Groq, Cerebras, the Vercel gateway -- and never launches anything itself.
 */
export const CATALOGUE_MAKER: Readonly<Record<string, string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google",
  xai: "xAI",
  mistral: "Mistral",
  moonshot: "Moonshot",
  kimi: "Moonshot",
  minimax: "MiniMax",
  zai: "Z.ai",
  "deepseek-api": "DeepSeek",
  "deepseek-pricing": "DeepSeek",
  dashscope: "Qwen",
  mimo: "Xiaomi",
  poolside: "Poolside",
};

/**
 * A lab nobody follows here, listed by a reseller: told the next morning, not at once.
 *
 * Six of these reached the scouts as cards between 2026-09-16 and 19 -- Typesafe's Jev, Unbiased's
 * Pareto, PrismML's Bonsai, Mixedbread's Toast, QuiverAI's Arrow twice -- and five were a catalogue
 * growing. The sixth, Jev, was the week's breakout: the Vercel gateway listed it fifteen hours
 * before any other catalogue and thirty repositories were built on it within three days. Whether a
 * maker is followed is what this tracker knows, not what the model is worth, so none of them is
 * dropped. Each is a line in the scouts' morning, and a card the moment it takes off (see
 * `breakouts.ts`), after which its maker is followed and the next model is a card on arrival.
 *
 * A stealth model hides its maker on purpose and is exactly what the scouts are for, and a row that
 * names no maker cannot be judged small; both stay sightings.
 */
const STEALTH = /^(?:stealth|openrouter|cloaked|anonymous)\/|\b(?:stealth|cloaked)\b/i;

/**
 * A model launched without a maker's name on it, and free to call from the hour it appears.
 *
 * OpenCode put `space-bunny-free` on Zen and Go at 14:29 on 2026-09-23 and OpenRouter listed
 * `stealth/space-bunny-alpha` at zero a quarter of an hour later; the same model reached the public
 * channel as "🆕 OpenCode Space Bunny Free on OpenCode Go" with two internal booleans printed as
 * fields, and the OpenRouter row went to the scouts as a separate sighting. For a reader on a $20
 * coding subscription a free frontier model that can be called today is the most actionable thing
 * this tracker sees all week, so it is a launch wherever it shows up.
 *
 * What makes one: a stealth namespace at a reseller, or a venue's free headline slot holding a name
 * no vendor claims. `deepseek-v4-flash-free` sits in the same slot and is not one -- its maker is
 * on the tin -- and neither is a paid row.
 */
const STEALTH_VENUES = new Set(["opencode-zen", "opencode-go"]);

export function isStealthLaunch(event: Event): boolean {
  if (event.kind !== "new" || (event.stream !== "api-models" && event.stream !== "openrouter")) return false;
  const record = recordFor(event);
  const id = text(record?.id) || event.entity_id;
  const name = text(record?.name) ?? "";
  if (vendorOfName(`${id} ${name}`) !== "Unknown") return false;
  if (STEALTH.test(id) || STEALTH.test(name)) return isFree(record);
  return STEALTH_VENUES.has(event.source) && record?.free === true;
}

/** A reseller gives a stealth model away while it is being watched: zero on both sides of the meter. */
function isFree(record: RecordData | null): boolean {
  const pricing = record?.pricing;
  if (!pricing || typeof pricing !== "object") return false;
  const rates = pricing as Record<string, unknown>;
  return ["prompt", "completion"].every((key) => Number(rates[key]) === 0);
}

/** What the venues are all listing: `space-bunny-free` and `stealth/space-bunny-alpha` are one model. */
const STEALTH_QUALIFIER = /-(?:free|alpha|beta|preview|exp|experimental)$/i;

export function stealthSubject(event: Event): string {
  const record = recordFor(event);
  const id = text(record?.model) || text(record?.id) || event.entity_id;
  return (id.split("/").at(-1) ?? id).toLowerCase().replace(STEALTH_QUALIFIER, "");
}

/** The maker a reseller's row names: its own attribution, or the namespace of the id. */
export function resellerMaker(event: Event): string | null {
  const record = recordFor(event);
  const id = text(record?.id) || event.entity_id;
  const words = `${id} ${text(record?.name) ?? ""}`;
  if (STEALTH.test(id) || STEALTH.test(words)) return null;
  return text(record?.maker) || (id.includes("/") ? id.split("/")[0] || null : null);
}

/**
 * The maker a row names, spelled the way the vendor table spells it, or null when it names nobody.
 *
 * The same reading for a registry as for a catalogue: `ibm-granite/granite-timeseries-ensemble-r1`
 * is IBM by its namespace exactly as `cohere/embed-v5.0-fast` is Cohere, and a weights row had no
 * way to say so until this was asked of it.
 */
function makerOfRow(event: Event): string | null {
  const maker = resellerMaker(event);
  if (!maker) return null;
  const record = recordFor(event);
  const named = vendorOfName(`${maker} ${text(record?.id) || event.entity_id} ${text(record?.name) ?? ""}`);
  return named === "Unknown" ? null : named;
}

/**
 * Weights published by a maker this reader does not follow.
 *
 * The registry had never been asked. IBM's Granite Timeseries Ensemble R1 -- a time-series
 * forecaster with twenty-five downloads -- reached the radar on 2026-10-05 with IBM already named
 * among the makers this feed is not for, and NVIDIA's Nemotron checkpoints had reached it the same
 * way, because `catalogueClass` asked the question of an api catalogue and never of a registry.
 *
 * Only a maker the vendor table can spell: an unknown lab publishing weights is the earliest word
 * on it anywhere and exactly what the radar is for, which is also what `breakouts.ts` promotes.
 * The row still counts as the week's arrival -- see `arrivalRejection`, which asks this -- because
 * what arrived is a wider question than what was worth a card.
 */
export function isAnUnfollowedMakersWeights(event: Event): boolean {
  return event.stream === "weights" && event.kind === "new" && isAMakerThisReaderDoesNotFollow(makerOfRow(event));
}

export function isUnfollowedMakerAtAReseller(event: Event): boolean {
  if (event.kind !== "new" || (event.stream !== "api-models" && event.stream !== "openrouter")) return false;
  if (!listsAnotherMakersModel(event)) return false;
  // A stealth row names nobody on purpose and is exactly what the radar is for; a row whose maker
  // the vendor table cannot spell is nobody this reader follows either, which at a reseller is the
  // same answer. A registry reads the second case the other way -- see `catalogueClass`.
  if (!resellerMaker(event)) return false;
  return !makerOfRow(event) || isAMakerThisReaderDoesNotFollow(makerOfRow(event));
}

/** True when a catalogue arrival is a platform listing somebody else's model, not its maker shipping it. */
export function listsAnotherMakersModel(event: Event): boolean {
  return event.kind === "new" && sellsAnotherMakersModel(event);
}

/** True when a catalogue row is a platform selling somebody else's model, whatever happened to it. */
export function sellsAnotherMakersModel(event: Event): boolean {
  if (event.stream !== "api-models" && event.stream !== "openrouter") return false;
  const owner = CATALOGUE_MAKER[event.source];
  if (!owner) return true;
  const record = recordFor(event);
  const named = vendorOfName(`${text(record?.id) || event.entity_id} ${text(record?.name)}`);
  return named !== "Unknown" && named !== owner;
}

/**
 * An entry that was listed but could not be picked, and now can. On an arena this is a model moving
 * from private testing to the public picker; in a catalogue it is the moment a listed model starts
 * answering. Six arena entries made that move in the week to 2026-09-10 and each was delivered
 * nowhere, as raw evidence.
 */
export function becameSelectable(event: Event): boolean {
  if (event.kind !== "changed" || !event.before_json || !event.after_json) return false;
  const before = JSON.parse(event.before_json) as { selectable?: unknown };
  const after = JSON.parse(event.after_json) as { selectable?: unknown };
  return before.selectable === false && after.selectable === true;
}

/** What a row in an API catalogue, a reseller's gateway or a weights registry is. */
export function catalogueClass(event: Event, record: RecordData | null): SignalClass {
  if (event.kind === "new") {
    /**
     * Weights in a registry are the earliest word on a model and the furthest from a reader
     * using one. Intern-S2-397B, Atria-Dawn-Preview and Atria-Dawn-Preview-Ascend-w8a8 all
     * reached the public channel as launches over two days: three separate repositories, none
     * of them callable without renting the hardware to serve it. A launch is a model somebody
     * can call, which is a row in an API catalogue.
     */
    if (event.stream === "weights" || record?.selectable === false)
      return isAnUnfollowedMakersWeights(event) ? "evidence" : "codename";
    /**
     * Asked before the modality question, because every answer below it is a sighting worth having
     * and this one is not. Asked after the maturity one, because a row nobody can call yet names
     * nobody either, and an unknown lab is exactly who the radar is for.
     * `cohere/embed-v5.0-fast` and `-pro` reached the radar as sightings on 2026-10-05 and were
     * both thumbed down: an embedding from a maker this reader does not follow is nowhere, and
     * the modality question used to reach it first and route it to the radar instead -- a rule
     * written to demote a launch acting as a promotion out of `evidence`.
     */
    if (isUnfollowedMakerAtAReseller(event)) return "evidence";
    /**
     * A model that speaks, listens, embeds or scores is not the model a reader of this feed
     * chose a subscription for. Two Gemini TTS rows reached the public channel on 2026-09-22 as
     * launches; nobody there is picking a voice. The sighting still belongs on the radar.
     */
    if (isAJobThisReaderDidNotComeFor(event, record)) return "codename";
    /**
     * And only in the catalogue of the company that made it. A platform listing somebody else's
     * model is a sighting, whoever owns the platform: `glm-5.3` appearing on Alibaba's DashScope
     * on 2026-09-15 reached the public channel as a launch, and Z.ai had shipped nothing that
     * day. Authority cannot answer this -- DashScope is first-party for Qwen and a reseller for
     * everyone else, and the Vercel gateway is recorded as vendor-owned while selling 26 makers'
     * models -- so the question is asked of the model's own name instead. Not of the record's
     * `maker`: the DashScope collector stamps "Alibaba Model Studio" on every row, GLM included.
     * A name that names nobody -- `whisper-1`, `codestral`, `wan2.5` -- is the catalogue's own.
     */
    return listsAnotherMakersModel(event) ? "codename" : "launch";
  }
  // Listed first and switched on later: the switch is the release. In the maker's own catalogue it
  // is a launch like any arrival would have been; anywhere else it is still a sighting.
  if (becameSelectable(event)) return listsAnotherMakersModel({ ...event, kind: "new" }) ? "codename" : "launch";
  // A row leaving a catalogue is not the vendor announcing anything: over the week to
  // 2026-09-15 the launch channel spent half its cards on four departures, each ending
  // something it had never been told arrived. It is a trail nobody has to read.
  if (event.kind === "removed") return "evidence";
  return "change";
}
