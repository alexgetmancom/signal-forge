/**
 * Numbers a catalogue writes, and which of them a reader pays.
 *
 * A price that moves at a reseller is what its customers pay; one that appears where a blank was is
 * the listing being finished, one that rebounds within the day is the routing, and a row a price
 * list bills per modality is not a model at all. What another catalogue already wrote about the
 * same model is here too, because it is the same question asked of a richer venue.
 */

import type { Database } from "bun:sqlite";
import { canonical } from "./canonical.js";
import { recordFor } from "./record.js";
import { CATALOGUE_MAKER } from "./resellers.js";
import type { Event } from "./types.js";

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
 * What another catalogue already knows about a stealth model, for the venue that carries none.
 *
 * OpenCode's row for Space Bunny was `{free, headline, id, maker, model, name}` and nothing else,
 * while models.dev had its million-token context and its modalities six minutes earlier and
 * OpenRouter had them a quarter of an hour later. Waiting for the richer venue spent the lead this
 * tracker exists to have; reading what is already stored spends nothing.
 */
const BORROWED_FIELDS = ["context", "input", "output", "maxOutputTokens", "reasoning", "pricing"];
/**
 * A price is borrowed only from the catalogues whose unit is known. Every other one writes its
 * rates in its own unit, and a sheet read in the wrong one is off by a million on a card people
 * quote; the unit of each of these is recorded against its name in `priceUnitForSource`.
 *
 * Three whose units are known beat five that have to be guessed. The gateways are resellers quoting
 * themselves and they list late: on the Claude Haiku 5.5 launch of 2026-10-07 the maker's API
 * answered at 17:51 and the first price anywhere appeared at 18:13, so the card went out with the
 * window and no price, as the two Claude launches before it had. `anthropic-pricing` is the maker's
 * own table, which is the only one that can be there at the same time as the model.
 */
const PRICED_BY = new Set(["anthropic-pricing", "openrouter", "vercel-gateway"]);

/**
 * How far two catalogues may differ on one window before a reader should be told they do.
 *
 * Mistral's own API answered 524288 for Mistral Large 4 on 2026-10-06 while the Vercel gateway,
 * models.dev and Mistral's own announcement all said a million. 207 of the 1,477 pairs of rows that
 * name one model in two catalogues disagree by more than this, so it is not one vendor's slip and
 * not something a card can resolve: it can only say that the number is contested. A fifth is wide
 * enough to pass a rounding difference and narrow enough to catch 512K against 1M.
 */
const CONTESTED = 0.2;

/**
 * One model's name with the differences that are only spelling taken out.
 *
 * A maker and a gateway write the same release two ways: Anthropic's own API answers
 * `claude-haiku-5-5` and every gateway carrying it writes `anthropic/claude-haiku-5.5`. Matching on
 * the raw text meant no row of Anthropic's ever matched a row of anybody else's, so a Claude launch
 * borrowed nothing at all -- not a price, not a window, not a modality -- while the Vercel gateway
 * held the full rate card for the same model. Measured against the stored catalogue, folding the
 * dot into the dash adds `vercel-gateway` and `models-dev` to the five venues `claude-haiku-5-5`
 * already found.
 */
function spelling(id: string): string {
  return (id.toLowerCase().split("/").at(-1) ?? "").trim().replace(/\./g, "-");
}

/**
 * Whether a stored row is the same model as the one on the card, strictly enough to argue with it.
 *
 * Borrowing a missing number tolerates a loose match, because a fuller row for a near neighbour
 * still beats a blank. Contradicting a number does not: `gpt-5` matches `gpt-5-mini` in the query
 * above, and their windows differ because they are different models. The provider prefix a gateway
 * puts in front -- `mistral/mistral-large-4` -- and a pinned version behind -- `-0` -- are the same
 * model; anything else is not.
 *
 * The pin is read off the spelling the catalogue used, before the dot is folded in, or the fold
 * manufactures one: `claude-sonnet-4.5` becomes `claude-sonnet-4-5`, whose trailing `-5` reads as a
 * pin and would make Sonnet 4.5 answer for Sonnet 4 -- and then contest its context window with a
 * number belonging to a different model.
 */
function namesTheSameModel(id: string, subject: string): boolean {
  const written = (id.toLowerCase().split("/").at(-1) ?? "").trim();
  return spelling(written) === subject || spelling(written.replace(/-\d+$/, "")) === subject;
}

export function borrowedFacts(db: Database, event: Event, raw: string): Record<string, unknown> {
  const subject = spelling(raw);
  const have: Record<string, unknown> = recordFor(event) ?? {};
  const wanted = BORROWED_FIELDS.filter((field) => have[field] === undefined || have[field] === null);
  const ours = typeof have.context === "number" && have.context > 0 ? have.context : null;
  if ((!wanted.length && ours === null) || subject.length < 4) return {};
  const borrowed: Record<string, unknown> = {};
  for (const row of db
    .query<{ body: string; source: string }, [string]>(
      // Both sides folded, so the maker's own `-5-5` meets the gateway's `.5`; see `spelling`.
      `SELECT body, source FROM records WHERE stream IN ('api-models','openrouter','weights')
       AND replace(lower(id), '.', '-') LIKE '%' || ? || '%' LIMIT 20`,
    )
    .all(subject)) {
    let fields: Record<string, unknown>;
    try {
      fields = JSON.parse(row.body) as Record<string, unknown>;
    } catch {
      continue;
    }
    // A window the maker's own row already carries is not borrowed, but a catalogue that answers a
    // different one is worth a reader's doubt: the card prints the number it was given and marks it.
    const theirs = typeof fields.context === "number" ? fields.context : null;
    if (
      ours !== null &&
      theirs !== null &&
      namesTheSameModel(String(fields.id ?? ""), subject) &&
      theirs > 0 &&
      Math.abs(theirs - ours) / Math.max(theirs, ours) > CONTESTED &&
      borrowed.contestedContext === undefined
    )
      Object.assign(borrowed, { contestedContext: theirs, contestedBy: row.source });
    for (const field of wanted) {
      if (field === "pricing" && !PRICED_BY.has(row.source)) continue;
      if (borrowed[field] === undefined && fields[field] !== undefined && fields[field] !== null) {
        borrowed[field] = fields[field];
        // A rate is only readable next to the catalogue it came from: one sheet writes dollars per
        // token and another per million, and a card that forgets which is off by a million.
        if (field === "pricing") borrowed.pricingSource = row.source;
      }
    }
  }
  return borrowed;
}

/**
 * The modality a price list bills a model for, read as a model of its own.
 *
 * Google's price catalogue writes what is being charged and then what it is charged on: "Generate
 * content input token count gemini 3.8 live image" is image tokens on Gemini 3.8 Live, not a model
 * called `gemini-3.8-live-image`. The collector reads a model out of the words and keeps both, so
 * the price list holds twenty names no other catalogue has ever listed, and `gemini-3.1-flash-image-image`
 * -- a real image model with the word said twice -- is the proof of what the last word is doing.
 *
 * The word cannot be stripped, because the same suffix is a real model four times over: Nano Banana
 * is `gemini-2.5-flash-image`. What separates them is not spelling but witness. So only the
 * modality-suffixed rows are held, and only until a second catalogue lists one -- everything else
 * this source sees first, such as `gemini-3.8-flash-cyber` or `lyria-3-clip`, still speaks on sight.
 *
 * On 2026-09-24 the phantom `gemini-3.8-live-image` took a codename card into the scouts' channel
 * while the real Gemini 3.8 Live, in the same poll, was rated evidence and got none.
 */
const BILLED_MODALITY = /-(image|text|audio|video|token|tokens)$/;

export function isTheModalityOfAPricedModel(db: Database, event: Event): boolean {
  if (event.source !== "google-skus" || event.kind !== "new") return false;
  const base = event.entity_id.replace(BILLED_MODALITY, "");
  if (base === event.entity_id) return false;
  // The model it is a price for is on the same list; without it there is no reading of this as a modality.
  if (!db.query("SELECT 1 FROM records WHERE source=? AND id=?").get(event.source, base)) return false;
  const elsewhere = db
    .query<{ count: number }, [string, string, string]>(
      "SELECT COUNT(*) count FROM records WHERE source<>? AND (id=? OR LOWER(json_extract(body,'$.name'))=?)",
    )
    .get(event.source, event.entity_id, event.entity_id);
  return (elsewhere?.count ?? 0) === 0;
}
