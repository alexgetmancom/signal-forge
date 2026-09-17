import type { Database } from "bun:sqlite";
import { canonical } from "./canonical.js";
import { normalizeIdentity } from "./identity.js";
import type { Event, RecordData } from "./types.js";
import { isBesideTheRelease } from "./variants.js";

/**
 * Observations that are true, cheap to make, and not worth a message.
 *
 * Each of these was read in the invited room on 14 September and could not be explained to the
 * person who owns the channel: a model entering a benchmark in fifth place, the same Kimi K3 served
 * through a gateway as though it were a stranger, and a catalogue row whose only change was that
 * the vendor's name had been prefixed to its own title.
 */

/**
 * A place on a board a reader would repeat to somebody else.
 *
 * One number, because two of them were two different answers to one question: this file suppressed
 * anything outside the top three while `notification.ts` called the top five reader-facing, so an
 * entry at rank four was both worth a card and not worth one depending on which guard ran.
 */
export const TOP_PLACES = 3;

function record(event: Event): RecordData | null {
  const body = event.after_json ?? event.before_json;
  return body ? (JSON.parse(body) as RecordData) : null;
}

/**
 * A board entry that is not near the top.
 *
 * Entering a benchmark at rank 2 is a fact about the frontier; entering it at rank 5, or sliding
 * from 6 to 7, is a fact about a table. Taking first place is always news, whichever way it moved.
 */
export function isMinorBoardMove(event: Event): boolean {
  if (event.stream !== "leaderboards") return false;
  const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  const place = Number(after?.rank ?? Number.NaN);
  if (event.kind === "new") return !(Number.isFinite(place) && place <= TOP_PLACES);
  if (event.kind === "removed") return Number(before?.rank ?? Number.NaN) > TOP_PLACES;
  // A change speaks when it puts something first, or takes something off the top.
  const was = Number(before?.rank ?? Number.NaN);
  return !(place === 1 || (was === 1 && place !== 1));
}

/**
 * The ways one model is served, as opposed to which model it is.
 *
 * `kimi-k3-gateway-max-v3` is Kimi K3 reached through a gateway at maximum thinking effort with the
 * third harness. An arena lists each wiring separately and each one arrived as an unidentified
 * sighting. These words can never distinguish two models, so a name that is a model we already know
 * plus only these is that model.
 */
const SERVING_WORDS = new Set([
  "gateway",
  "official",
  "api",
  "direct",
  "proxy",
  "harness",
  "endpoint",
  "chat",
  "thinking",
  "reasoning",
  "max",
  "high",
  "medium",
  "low",
  "effort",
]);

/** A number straight after the model's name is its version: `grok 4` + `6` is Grok 4.6, not a wiring of Grok 4. */
function servingTail(words: string[]): boolean {
  return (
    words.length > 0 &&
    !/^\d+$/.test(words[0] ?? "") &&
    words.every((word) => SERVING_WORDS.has(word) || /^v?\d+$/.test(word))
  );
}

/** Models something in this database already identifies, as normalized word lists. */
export function knownModelNames(db: Database): string[][] {
  const names = new Set<string>();
  for (const row of db
    .query<{ body: string }, []>(
      "SELECT body FROM records WHERE stream IN ('api-models','openrouter','weights','deprecations')",
    )
    .all()) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.body) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const value of [parsed.name, parsed.id])
      if (typeof value === "string" && value.trim()) {
        // A catalogue writes "DeepSeek: DeepSeek V4 Flash"; the maker's prefix is not part of the
        // model's name, and an arena never repeats it.
        const stripped = value.replace(/^[^:/]+[:/]\s*/, "");
        names.add(normalizeIdentity(stripped));
      }
  }
  return [...names].filter((name) => name.split(" ").length >= 2).map((name) => name.split(" "));
}

/** True when this arena entry is a known model with only its wiring appended. */
export function isAnotherServing(event: Event, known: readonly string[][]): boolean {
  if (event.stream !== "arena" || event.kind !== "new") return false;
  const words = normalizeIdentity(String(record(event)?.name ?? event.entity_id))
    .split(" ")
    .filter(Boolean);
  return known.some(
    (model) =>
      words.length > model.length &&
      model.every((word, index) => words[index] === word) &&
      servingTail(words.slice(model.length)),
  );
}

/** Fields that say how a record is addressed and displayed, not what it is. */
const LABELS = new Set(["name", "model", "modelKey", "slug", "title"]);

/**
 * A change that is only a change of label.
 *
 * OpenRouter prefixed its own catalogue titles with the vendor, and "DeepSeek V4 Flash Latest"
 * became "DeepSeek: DeepSeek V4 Flash Latest" -- a card, in a channel, about a display string. An
 * arena is the exception: a codename acquiring a real name is the entire point of watching one.
 */
export function isLabelOnlyChange(event: Event): boolean {
  if (event.kind !== "changed" || event.stream === "arena" || event.stream === "leaderboards") return false;
  const before = event.before_json ? (JSON.parse(event.before_json) as Record<string, unknown>) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as Record<string, unknown>) : null;
  if (!before || !after) return false;
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => canonical(before[key]) !== canonical(after[key]),
  );
  return changed.length > 0 && changed.every((key) => LABELS.has(key));
}

/**
 * A row that exists to point at whatever is newest.
 *
 * `~deepseek/deepseek-v4-flash-latest` is not a model: it is a promise to route to one. Its every
 * move duplicates a card the model behind it already produced.
 */
export function isAliasRow(event: Event): boolean {
  const name = String(record(event)?.name ?? event.entity_id);
  return /[:\s/-]latest$/i.test(name.trim()) || event.entity_id.startsWith("~");
}

/**
 * A vendor's newsroom is not a release feed: the same heading carries a model launch, a board
 * appointment, a policy essay and a customer profile, and the source cannot be asked which is
 * which. Two things a post itself can be asked, though.
 *
 * It can be asked whether it names a model this deployment already knows from a catalogue, and
 * whether the vendor introduced something in its own title. Measured over the twenty-two newsroom
 * posts of the week to 2026-09-14: twelve are cut, and not one of them is an announcement --
 * journalism grants, a Millennium Prize essay, a board appointment, a storage-scaling writeup. Ten
 * speak, including every launch of the week, and four of those ten are customer stories that name
 * a real model, which is the price of not losing the launches.
 *
 * This is a filter on the card, never on the collection: the post is stored either way, and the
 * suppression carries its reason.
 */
const ANNOUNCES = /^\s*(introducing|announcing|launching|meet)\s/i;

export function isAboutTheCompanyNotAModel(event: Event, known: readonly string[][]): boolean {
  if (event.stream !== "news") return false;
  const body = record(event);
  const title = String(body?.name ?? "");
  if (ANNOUNCES.test(title)) return false;
  const haystack = normalizeIdentity([title, body?.summary, body?.description].filter(Boolean).join(" "));
  return !known.some((words) => haystack.includes(words.join(" ")));
}

/**
 * A dated snapshot or a billing tier of a model the same catalogue already lists.
 *
 * OpenAI listed `gpt-image-2.5-flare` and `gpt-image-2.5-flare-2026-09-08` in the collection of
 * 2026-09-09 17:07, and both reached the wire as launches: four cards for two models. OpenRouter
 * lists Mistral's models a second time as `:batch` rows -- five of them in one hour on 2026-09-10,
 * each a sighting in the invited room of a model that shipped months before. Either is news only
 * when the plain row is not there: a model can first appear as its snapshot, and that one speaks.
 * `-preview` is not a tier. Google launches under it.
 */
const TIER_SUFFIX = /(-\d{4}-\d{2}-\d{2}|:(batch|free|beta|extended|thinking|floor|nitro|online))$/i;

export function isAnotherTierOfAListedModel(db: Database, event: Event): boolean {
  if (event.kind !== "new" || (event.stream !== "api-models" && event.stream !== "openrouter")) return false;
  const plain = event.entity_id.replace(TIER_SUFFIX, "");
  if (plain === event.entity_id) return false;
  return Boolean(db.query("SELECT 1 FROM records WHERE source=? AND id=?").get(event.source, plain));
}

/**
 * A trending model its own lab already published under an account collected as a source.
 *
 * The lab's account sees the weights the hour they land; the trending list sees the same repository
 * a day later, once people have liked it. `deepseek-ai/DeepSeek-V4.1-Flash` topped the list on
 * 2026-09-16 six days after `huggingface:deepseek-ai` reported it.
 */
export function isPublishedByAFollowedLab(db: Database, event: Event): boolean {
  if (!event.source.startsWith("discovery:huggingface") || event.kind !== "new") return false;
  return Boolean(
    db.query("SELECT 1 FROM records WHERE source LIKE 'huggingface:%' AND lower(id)=lower(?)").get(event.entity_id),
  );
}

/**
 * The model a vendor page is about, read from its address.
 *
 * Gemini 3.8 Live reached the invited room as `/models/model-cards/gemini-3-8-audio` on DeepMind and
 * `/gemini-api/docs/models/gemini-3.8-live` plus its extended-thinking page on the Gemini API docs,
 * inside thirty-four minutes on 2026-09-15. Story correlation keeps them apart because the slugs name
 * the model three ways, and it should: `gemini 3 8 audio` and `gemini 3.8 live` are different
 * products to anything that reads names. What they share is the family and the version, and a
 * reader told a vendor's pages have started naming Gemini 3.8 needs telling once.
 */
const PAGE_MODEL =
  /(?:^|[/_\s-])(gemini|gemma|claude|opus|sonnet|haiku|gpt|grok|llama|qwen|glm|kimi|deepseek|mistral|veo|imagen|lyria)[-_\s]?(\d{1,2})(?:[.-](\d{1,2}))?(?![\d.])/i;

const PAGE_TIER = /(?:^|[-_\s])(flash|pro|ultra|lite|nano|mini)(?=$|[-_\s])/i;

export function pageModel(event: Event): string | null {
  if (event.stream !== "pages" || event.kind !== "new") return null;
  const path = decodeURIComponent(event.entity_id);
  const match = PAGE_MODEL.exec(path);
  if (!match?.[1] || !match[2]) return null;
  // Live and audio are one model written two ways; Flash and Pro at the same version are two, and a
  // Gemini 3.8 Pro page after a told 3.8 Flash page is the news, not a repeat.
  const slug = path.slice(match.index + match[0].length).split("/")[0] ?? "";
  const tier = PAGE_TIER.exec(slug)?.[1]?.toLowerCase();
  return `${match[1].toLowerCase()} ${match[2]}${match[3] ? `.${match[3]}` : ""}${tier ? ` ${tier}` : ""}`;
}

/**
 * Weights a followed lab published that declare nothing to run.
 *
 * `tencent/WeVisDoc-2B` and `-4B` reached the invited room on 2026-09-17 with no pipeline, no
 * downloads and a document-retrieval purpose nobody there came for. The recap already left such
 * repositories out; the cards did not.
 */
export function isWeightsBesideTheRelease(event: Event): boolean {
  return event.kind === "new" && event.source.startsWith("huggingface:") && isBesideTheRelease(record(event));
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
  const created = Date.parse(String(record(event)?.created ?? ""));
  return Number.isFinite(created) && Date.parse(event.detected_at) - created > LONG_PUBLISHED_MS;
}
