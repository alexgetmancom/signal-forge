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
import { parseRecord } from "./recordBody.js";
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
  const before = parseRecord(event.before_json);
  const after = parseRecord(event.after_json);
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
  const before = parseRecord(event.before_json);
  const after = parseRecord(event.after_json);
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
const BORROWED_FIELDS = ["context", "input", "output", "reasoning", "pricing"];
/**
 * A price is borrowed only from the catalogues whose unit is known, both of which write dollars per
 * token. Every other one writes its rates in its own unit, and a sheet read in the wrong one is off
 * by a million on a card people quote. Two whose units are known beat five that have to be guessed:
 * with OpenRouter alone, a Claude launch card carried the context and no price, because Anthropic
 * reaches the gateway first and OpenRouter an hour later.
 */
const PRICED_BY = new Set(["openrouter", "vercel-gateway"]);

export function borrowedFacts(db: Database, event: Event, subject: string): Record<string, unknown> {
  const have: Record<string, unknown> = recordFor(event) ?? {};
  const wanted = BORROWED_FIELDS.filter((field) => have[field] === undefined || have[field] === null);
  if (!wanted.length || subject.length < 4) return {};
  const borrowed: Record<string, unknown> = {};
  for (const row of db
    .query<{ body: string; source: string }, [string]>(
      `SELECT body, source FROM records WHERE stream IN ('api-models','openrouter','weights')
       AND lower(id) LIKE '%' || ? || '%' LIMIT 20`,
    )
    .all(subject)) {
    let fields: Record<string, unknown>;
    try {
      fields = JSON.parse(row.body) as Record<string, unknown>;
    } catch {
      continue;
    }
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
