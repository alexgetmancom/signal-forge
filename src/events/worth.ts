import type { Database } from "bun:sqlite";
import { isTellableDebut } from "./boardSignals.js";
import { canonical } from "./canonical.js";
import { normalizeIdentity } from "./identity.js";
import { opensByAnnouncing } from "./newsrooms.js";
import { recordFor } from "./record.js";
import type { Event, RecordData } from "./types.js";

/**
 * Observations that are true, cheap to make, and not worth a message.
 *
 * Each of these was read in the invited room on 14 September and could not be explained to the
 * person who owns the channel: a model entering a benchmark in fifth place, the same Kimi K3 served
 * through a gateway as though it were a stranger, and a catalogue row whose only change was that
 * the vendor's name had been prefixed to its own title.
 *
 * What is left here is the shape of a change itself -- which fields moved, whether a name was all
 * that moved, where on a board it happened. The rules that need a subject of their own are named
 * after it: `nameWorth`, `priceWorth`, `pageWorth`, `weightsWorth`, `retoldWorth`, `buildWorth`.
 */

/**
 * A place on a board a reader would repeat to somebody else.
 *
 * One number, because two of them were two different answers to one question: this file suppressed
 * anything outside the top three while `notification.ts` called the top five reader-facing, so an
 * entry at rank four was both worth a card and not worth one depending on which guard ran.
 *
 * It answers one question only: how far down the table a row moving is still worth reading. A row
 * arriving is a different question with its own number, `DEBUT_PLACES`, and both guards ask it
 * through `isTellableDebut` so that they cannot answer it differently either.
 */
export const TOP_PLACES = 3;

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
  // A debut is told to the tenth place on a board people quote; a row moving is told to the third.
  if (event.kind === "new") return !(isTellableDebut(event) || (Number.isFinite(place) && place <= TOP_PLACES));
  if (event.kind === "removed") return Number(before?.rank ?? Number.NaN) > TOP_PLACES;
  // A change speaks when it puts something first, or takes something off the top.
  const was = Number(before?.rank ?? Number.NaN);
  return !(place === 1 || (was === 1 && place !== 1));
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
  const body = recordFor(event);
  const title = String(body?.name ?? "");
  // The title when it says so, the opening sentence when the title is a headline instead.
  if (ANNOUNCES.test(title) || opensByAnnouncing(body)) return false;
  const haystack = normalizeIdentity([title, body?.summary, body?.description].filter(Boolean).join(" "));
  return !known.some((words) => haystack.includes(words.join(" ")));
}

/**
 * A trending repository the lab's own account already lists, which is where it was read from.
 *
 * The lab's account sees the weights the hour they land; the trending list sees the same repository
 * a day later, once people have liked it. `deepseek-ai/DeepSeek-V4.1-Flash` topped the list on
 * 2026-09-16 six days after `huggingface:deepseek-ai` reported it, and `Qwen/Qwen-Image-2.1` reached
 * the scouts from `huggingface:Qwen` on 2026-09-20 thirty-one minutes before the trending row for it
 * arrived.
 *
 * The reason this makes used to be called `published_by_a_followed_lab`, which named the publisher
 * and so read as an argument for sending rather than the duplicate it is: a lab we follow publishing
 * weights is the news, and this rule fires precisely because that news already travelled. What holds
 * the row back is that the same repository is in `records` under the lab's own source, which is the
 * only thing the name may say.
 */
export function isAlreadyListedByItsLab(db: Database, event: Event): boolean {
  if (!event.source.startsWith("discovery:huggingface") || event.kind !== "new") return false;
  return Boolean(
    db.query("SELECT 1 FROM records WHERE source LIKE 'huggingface:%' AND lower(id)=lower(?)").get(event.entity_id),
  );
}
