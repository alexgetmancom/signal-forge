import type { Database } from "bun:sqlite";
import { canonical } from "./canonical.js";
import { normalizeIdentity } from "./identity.js";
import { CATALOGUE_MAKER } from "./signals.js";
import type { Event, RecordData } from "./types.js";
import { isBesideTheRelease } from "./variants.js";
import { vendorOfName } from "./vendors.js";
import { meaningfulWebString, normalizeWebString, tellingWebString } from "./web.js";

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
  // Search Arena lists Claude Opus 5 as `claude-opus-5-search`: the released model with a search
  // tool attached, two of them on 2026-09-18.
  "search",
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
 * The keys a change only added, or null when it changed or removed anything.
 *
 * Our own parser is the most frequent author of these. On 2026-09-22 five cards went out because
 * the Command Code and opencode collectors started emitting a `model` field: every record read that
 * day differed from the one stored, and each difference was `{"id":"gpt-5.4-mini"}` gaining
 * `"model":"gpt-5.4-mini"`. The signature is what the batch compares, so one field appearing across
 * a source's records at once is recognised as the schema moving, not the models.
 */
export function addedFieldSignature(event: Event): string | null {
  if (event.kind !== "changed" || !event.before_json || !event.after_json) return null;
  const before = JSON.parse(event.before_json) as Record<string, unknown>;
  const after = JSON.parse(event.after_json) as Record<string, unknown>;
  const added: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (canonical(before[key]) === canonical(after[key])) continue;
    if (before[key] !== undefined) return null;
    added.push(key);
  }
  return added.length ? added.sort().join(",") : null;
}

/**
 * The whole of what a change did, as a string two records can be compared by.
 *
 * One read of the Codex model list on 2026-09-23 gave six cards, and all six said the same thing:
 * OpenAI had added the plan tiers `ent26` and `promax` to every model it lists. The first card is
 * the news; the other five are the same news with another model's name on it.
 */
export function changeSignature(event: Event): string | null {
  if (event.kind !== "changed" || !event.before_json || !event.after_json) return null;
  const before = JSON.parse(event.before_json) as Record<string, unknown>;
  const after = JSON.parse(event.after_json) as Record<string, unknown>;
  const moves = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => canonical(before[key]) !== canonical(after[key]))
    .sort()
    .map((key) => {
      const was = new Set(Array.isArray(before[key]) ? (before[key] as unknown[]).map((one) => String(one)) : []);
      const now = new Set(Array.isArray(after[key]) ? (after[key] as unknown[]).map((one) => String(one)) : []);
      // A list is compared by what entered and left it, so two records holding different lists that
      // gained the same entry are recognised as one change.
      if (was.size || now.size) {
        const added = [...now].filter((one) => !was.has(one)).sort();
        const gone = [...was].filter((one) => !now.has(one)).sort();
        return `${key}:+${added.join(",")}:-${gone.join(",")}`;
      }
      return `${key}:${canonical(before[key])}>${canonical(after[key])}`;
    });
  return moves.length ? moves.join("|") : null;
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

/**
 * A price OpenRouter shows moving, which is usually the provider it routes to changing.
 *
 * Measured on production 2026-09-18 over the fourteen days before: 178 moves of a quarter or more
 * on OpenRouter, 108 of them back at the starting price within a day and 51 within six hours.
 * DeepSeek V4 Pro reached the public channel 41% cheaper at 04:09 and 70% dearer at 06:43. The
 * daily recap reads each row's net move and drops a row that went both ways, which is the only
 * reading of these numbers that survives the routing.
 */
export function isLeftToTheDailyRecap(event: Event): boolean {
  if (event.kind !== "changed" || event.source !== "openrouter") return false;
  const before = event.before_json ? (JSON.parse(event.before_json) as Record<string, unknown>) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as Record<string, unknown>) : null;
  if (!before || !after) return false;
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => canonical(before[key]) !== canonical(after[key]),
  );
  return changed.length > 0 && changed.every((key) => key === "pricing");
}

/**
 * A reseller filling in a price it had left empty.
 *
 * Fish Audio's four voice models reached the public channel from the Vercel gateway on 2026-09-18
 * because the gateway started showing prices for models it already listed. A price that moves at a
 * reseller still speaks: that is what its customers pay. One that appears says only that the
 * listing was finished.
 */
export function isAResellerFillingInAPrice(event: Event): boolean {
  if (event.kind !== "changed" || CATALOGUE_MAKER[event.source]) return false;
  if (event.stream !== "api-models" && event.stream !== "openrouter") return false;
  const before = event.before_json ? (JSON.parse(event.before_json) as Record<string, unknown>) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as Record<string, unknown>) : null;
  if (!before || !after) return false;
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => canonical(before[key]) !== canonical(after[key]),
  );
  // Any field a reseller had left blank and now fills in, not only the price: Vercel's gateway listed
  // Typesafe's Jev with a context of 0 and wrote 32K two days later, and "Context 0 → 32K" reached
  // the public wire on 2026-09-19 as a change. A zero is the same blank written as a number.
  const blank = (value: unknown) =>
    value === null ||
    value === undefined ||
    value === 0 ||
    value === "" ||
    (typeof value === "object" && !Object.keys(value).length);
  // Only the numbers a listing is finished with; a description or a timestamp appearing is an edit.
  const fillable = (key: string) => /pricing|context|limit|tokens|max_?output/i.test(key);
  return changed.length > 0 && changed.every((key) => fillable(key) && blank(before[key]));
}

/**
 * A new page on a vendor's site whose address names no product of theirs.
 *
 * A page appearing before the announcement is a sighting when it is about something to use.
 * "/news/accenture-embedded-evaluation" reached the scouts on 2026-09-18, and the disrupting-
 * malicious-uses series sent eight in one minute on 2026-09-16: customer stories and reports, which
 * the vendor's newsroom feed tells as what they are.
 */
const PAGE_PRODUCT =
  /(?:^|[/_\s-])(?:claude|cowork|opus|sonnet|haiku|fable|mythos|gpt|o\d|chatgpt|codex|sora|gemini|gemma|veo|imagen|lyria|notebooklm|antigravity|jules|grok|aurora|llama|muse|qwen|glm|kimi|deepseek|mistral|models?)(?=$|[/_\s.-]|\d)/i;

/**
 * Only the sections a vendor writes stories in. Documentation is the product itself: the Claude CLI's
 * `sessions connect` and `apply` pages named no product and were new commands.
 */
const EDITORIAL_SECTION =
  /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:news|index|research|institute|business|solutions|customers|stories|blog)\//i;

export function isPageWithoutAProduct(event: Event): boolean {
  if (event.stream !== "pages" || event.kind !== "new") return false;
  const path = decodeURIComponent(event.entity_id);
  return EDITORIAL_SECTION.test(path) && !PAGE_PRODUCT.test(path);
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

/**
 * A sighting of a model its maker already sells.
 *
 * `glm-5.3-flashx` reached the scouts from the Vercel gateway on 2026-09-18 three minutes after Z.ai's
 * own catalogue put it on the public channel, and a fourth Arena entry for the released
 * `mimo-v2.5-pro` followed. A sighting is the earliest word on a model; after the maker's own
 * catalogue it is the latest.
 *
 * Not on an arena. That Arena entry was created at 06:02 on 2026-09-18 (its id is a UUIDv7) with no
 * provider, while the released one is served by `xiaomiV1` and Xiaomi had been training
 * mimo-v2.6-pro in public since 2026-09-15; a bare `gemini-3.8-flash` appeared the same way on
 * 2026-09-17, which readers took for the next Gemini. A released name is how a successor is tested
 * blind, so a new entry under one is a sighting, not a repeat.
 */
export function isAlreadyOutAtItsMaker(event: Event, elsewhere: readonly string[]): boolean {
  if (event.kind !== "new" || event.stream === "arena") return false;
  const maker = vendorOfName(`${event.entity_id} ${String(record(event)?.name ?? "")}`);
  return maker !== "Unknown" && elsewhere.some((source) => makerOfListing(source) === maker);
}

/**
 * What another catalogue already knows about a stealth model, for the venue that carries none.
 *
 * OpenCode's row for Space Bunny was `{free, headline, id, maker, model, name}` and nothing else,
 * while models.dev had its million-token context and its modalities six minutes earlier and
 * OpenRouter had them a quarter of an hour later. Waiting for the richer venue spent the lead this
 * tracker exists to have; reading what is already stored spends nothing.
 */
const BORROWED_FIELDS = ["context", "input", "output", "reasoning"];

export function borrowedFacts(db: Database, event: Event, subject: string): Record<string, unknown> {
  const have: Record<string, unknown> = record(event) ?? {};
  const wanted = BORROWED_FIELDS.filter((field) => have[field] === undefined || have[field] === null);
  if (!wanted.length || subject.length < 4) return {};
  const borrowed: Record<string, unknown> = {};
  for (const row of db
    .query<{ body: string }, [string]>(
      `SELECT body FROM records WHERE stream IN ('api-models','openrouter','weights')
       AND lower(id) LIKE '%' || ? || '%' LIMIT 20`,
    )
    .all(subject)) {
    let fields: Record<string, unknown>;
    try {
      fields = JSON.parse(row.body) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const field of wanted)
      if (borrowed[field] === undefined && fields[field] !== undefined && fields[field] !== null)
        borrowed[field] = fields[field];
  }
  return borrowed;
}

/** Past this, a catalogue adding a model is catching up with a release, not carrying one. */
const ALREADY_OUT_MS = 30 * 24 * 3_600_000;

const CREATED_FIELDS = ["created", "createdAt", "created_at", "releaseDate", "release_date"];

/**
 * A model that was already out when this catalogue listed it, on a row that names no maker.
 *
 * `isAlreadyOutAtItsMaker` asks who published the model and finds the maker's own listing beside
 * this one. An importer defeats that by naming nobody: Azure's row for Meta's Muse Glimmer 30B is
 * `azure-ai-foundry/Muse-Glimmer-30B` and says "microsoft-foundry", so the model read as new on
 * 2026-09-21, six weeks after Meta uploaded it and while five catalogues were already selling it.
 *
 * What the row does not say, another catalogue's record does: OpenRouter and Hugging Face both carry
 * the date a model was created. Reading it there dates the release without a lookup, and a month is
 * long enough that no reader is still waiting for the news.
 */
export function wasReleasedLongBefore(db: Database, event: Event): boolean {
  if (event.kind !== "new" || (event.stream !== "api-models" && event.stream !== "openrouter")) return false;
  const cutoff = Date.parse(event.detected_at) - ALREADY_OUT_MS;
  if (createdBefore(record(event), cutoff)) return true;
  const id = (record(event)?.id ?? event.entity_id) as string;
  const name = String(id).split("/").at(-1)?.toLowerCase() ?? "";
  // A name without a digit and a separator is a word, and a word matches half the catalogue.
  if (name.length < 6 || !/\d/.test(name) || !/[-_.]/.test(name)) return false;
  return db
    .query<{ body: string }, [string]>(
      `SELECT body FROM records WHERE stream IN ('api-models','openrouter','weights')
       AND lower(id) LIKE '%' || ? || '%' LIMIT 20`,
    )
    .all(name)
    .some((row) => {
      try {
        return createdBefore(JSON.parse(row.body) as Record<string, unknown>, cutoff);
      } catch {
        return false;
      }
    });
}

/** Before this, a date is a placeholder rather than a release: catalogues write `created: 1`. */
const EARLIEST_RELEASE = Date.parse("2015-01-01T00:00:00.000Z");

/** The date a record puts on the model itself, in the two shapes catalogues write it. */
function releaseDate(value: unknown): number | null {
  const at =
    typeof value === "number"
      ? // A catalogue writes an epoch, in seconds on OpenRouter and in milliseconds elsewhere.
        value * (value > 1e11 ? 1 : 1000)
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  return Number.isFinite(at) && at >= EARLIEST_RELEASE ? at : null;
}

/** True when a record dates the model itself, and that date is older than the cutoff. */
function createdBefore(fields: Record<string, unknown> | null | undefined, cutoff: number): boolean {
  return CREATED_FIELDS.some((field) => {
    const at = releaseDate(fields?.[field]);
    return at !== null && at < cutoff;
  });
}

/**
 * The maker a listing belongs to, when the listing is the maker's own. Weights under the maker's own
 * Hugging Face organisation are that maker releasing the model: GLM-4.7 Flash reached the scouts
 * from Vertex Model Garden on 2026-09-18, eight months after `zai-org` published it, because Z.ai's
 * API catalogue no longer lists it.
 */
function makerOfListing(source: string): string | undefined {
  if (source.startsWith("huggingface:")) return vendorOfName(source.slice("huggingface:".length));
  return CATALOGUE_MAKER[source];
}

/** The versioned model names a string mentions. */
const MODEL_NAME =
  /\b(?:claude|opus|sonnet|haiku|gpt|o\d|gemini|grok|codex|llama|qwen|deepseek|kimi|glm|mistral)[\s-]?\d[\w.-]*/gi;

/** How long a model stays told, for a release note that names nothing else. */
const TOLD_WINDOW_MS = 7 * 24 * 3_600_000;

/**
 * A release note whose every named model this destination has already been sent.
 *
 * ChatGPT's release notes said "GPT-6 Sol and Luna in Work and Codex" on 2026-09-23, nine hours
 * after both models reached the same readers as launches. An interface catching up with a model is
 * not a second piece of news about it. A note that names a model nobody here has heard of still
 * speaks, and so does one that names none at all, which is most of them.
 */
export function retellsToldModels(db: Database, event: Event, destinationId: string, asOf?: string): boolean {
  if (event.stream !== "news" || event.kind !== "new") return false;
  const body = record(event);
  const named = `${String(body?.name ?? "")} ${String(body?.summary ?? "")}`.match(MODEL_NAME) ?? [];
  if (!named.length) return false;
  const at = asOf ?? new Date().toISOString();
  const since = new Date(Date.parse(at) - TOLD_WINDOW_MS).toISOString();
  const told = db
    .query<{ name: string }, [string, string, string]>(
      `SELECT COALESCE(json_extract(e.after_json,'$.name'),e.entity_id) AS name
       FROM delivery_events de JOIN deliveries d ON d.id=de.delivery_id JOIN events e ON e.id=de.event_id
       WHERE d.destination_id=? AND d.status='sent' AND e.detected_at>=? AND e.detected_at<=?`,
    )
    .all(destinationId, since, at)
    .map((row) => normalizeIdentity(String(row.name)));
  if (!told.length) return false;
  return named.every((model) => {
    const name = normalizeIdentity(model);
    return told.some((one) => one === name || one.startsWith(`${name} `) || one.includes(name));
  });
}

/**
 * A documentation diff whose only tell is a model this deployment already knows./**
 * A documentation diff whose only tell is a model this deployment already knows.
 *
 * Codex's subagent page swapped `gpt-5.3-codex-spark` for `gpt-5.6-luna` in two TOML examples on
 * 2026-09-18 and reached the scouts as a sighting; GPT-5.6 Luna had been on OpenRouter and the
 * Arena since 2026-09-09. A string that also says preview, beta or coming soon still speaks.
 */
export function namesOnlyKnownModels(event: Event, known: readonly string[][]): boolean {
  if (event.stream !== "web" || event.kind !== "changed") return false;
  const before = event.before_json ? (JSON.parse(event.before_json) as { strings?: unknown }) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as { strings?: unknown }) : null;
  const old = new Set(Array.isArray(before?.strings) ? before.strings : []);
  const telling = (Array.isArray(after?.strings) ? after.strings : []).filter(
    (value): value is string =>
      typeof value === "string" && !old.has(value) && meaningfulWebString(value) && tellingWebString(value),
  );
  if (!telling.length) return false;
  const names = known.map((words) => words.join(" "));
  return telling.every((value) => {
    const normalized = normalizeWebString(value);
    const models = normalized.match(MODEL_NAME) ?? [];
    if (!models.length || tellingWebString(normalized.replace(MODEL_NAME, " "))) return false;
    return models.every((model) => {
      const name = normalizeIdentity(model);
      return names.some((knownName) => knownName === name || knownName.startsWith(`${name} `));
    });
  });
}

/**
 * A tool build that only fixes things.
 *
 * Claude Code 2.1.276 reached the public channel on 2026-09-18 to say one proxy regression from
 * 2.1.275 was fixed; 2.1.270 and 2.1.272 ("Bug fixes and reliability improvements") had done the
 * same in the week before. A reader who uses the tool updates anyway; one who does not learns nothing.
 */
const ADDS =
  /\b(added|adds|new (?:features?|commands?|models?|settings?|options?|flags?|tools?)|introduc\w*|now (?:supports?|available)|launch\w*)\b/i;
const FIXES = /^[\s#]*(fixed|fixes|bug fixes)\b/i;
const VERSION = /\b\d+\.\d+\.\d+\b/;

/**
 * Codex 0.155.1 reached the public channel twice on 2026-09-18, from its GitHub release and from the
 * Codex changelog, to say one default was restored. The release carries its version as a tag and
 * the changelog only in its title, the summary opens with a Markdown heading, and the one fix begins
 * "New local TUI sessions" -- a bare "new" is an adjective as often as it is a feature.
 */
export function isFixesOnlyRelease(event: Event): boolean {
  if (event.kind !== "new" || (event.stream !== "news" && event.stream !== "github")) return false;
  const body = record(event);
  if (!body || (!body.version && !body.tag && !VERSION.test(String(body.name ?? "")))) return false;
  const summary = String(body.summary ?? body.description ?? "");
  return FIXES.test(summary) && !ADDS.test(summary);
}
