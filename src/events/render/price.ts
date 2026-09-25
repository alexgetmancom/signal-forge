/**
 * What a price did, in the sizes a reader compares it by.
 *
 * One rate is picked -- the one a reader pays most -- and everything else is how that move is said:
 * as a percentage, as a multiple, as a sentence, as the pills on a picture. The rounding rule is
 * here for a reason: a move rounded to nothing announced "0% cheaper" to a channel on 2026-09-22.
 * Moved out of discord.ts unchanged.
 */
import type { Event, RecordData } from "../types.js";
import { pricePair } from "./common.js";
import { place } from "./words.js";

/** The rate a reader pays most, before and after, when it moved. */
export function priceMove(
  event: Event,
  before: RecordData,
  after: RecordData,
): { from: number; to: number; field: string } | null {
  const old = (before.pricing ?? {}) as Record<string, unknown>;
  const next = (after.pricing ?? {}) as Record<string, unknown>;
  const key = ["completion", "output", "prompt", "input"].find((name) =>
    pricePair(old[name], next[name], event.source),
  );
  const pair = key ? pricePair(old[key], next[key], event.source) : null;
  if (!key || !pair || pair.from <= 0 || pair.from === pair.to) return null;
  return { ...pair, field: key === "completion" || key === "output" ? "output" : "input" };
}

/** "−30%", "+40%", "2×": how far a price moved, in the size a reader compares. */
export function priceStep(from: number, to: number): string {
  if (to < from) return `−${percent((1 - to / from) * 100)}`;
  const ratio = to / from;
  return ratio >= 1.95 ? `${Number(ratio.toFixed(1))}×` : `+${percent((ratio - 1) * 100)}`;
}

/**
 * A move rounded to nothing is not a move a reader can read. "DeepSeek Pro Latest is 0% cheaper"
 * went out on 2026-09-22: the card announced that a price had changed by nothing at all.
 */
function percent(value: number): string {
  return `${value < 1 ? Number(value.toFixed(1)) : Math.round(value)}%`;
}

/** "2× more expensive on OpenRouter", "30% cheaper on OpenRouter", from the rate a reader pays most. */
export function priceSentence(event: Event, before: RecordData, after: RecordData): string | null {
  const move = priceMove(event, before, after);
  if (!move) return null;
  const where = place(event.source);
  const step = priceStep(move.from, move.to);
  if (move.to < move.from) return `${step.slice(1)} cheaper on ${where}.`;
  return step.endsWith("×") ? `${step} more expensive on ${where}.` : `${step.slice(1)} more expensive on ${where}.`;
}

export const dollars = (value: number) => `$${Number(value.toFixed(value < 1 ? 3 : 2))}`;

/**
 * The rates a model is chosen by, as pills. One pill holding "$0.1 in · $0.5 out" ran three times
 * the width of the "1M context" beside it and left the row lopsided; two short pills sit evenly.
 */
export function priceChips(value: string): string[] {
  const trimmed = value.replace(/\s*\/\s*1M tokens$/, "");
  const rates = trimmed.split(" · ").filter((rate) => /\b(in|out)$/.test(rate));
  // A sheet with no in or out rate at all is quoted as it came rather than quoted as nothing.
  return rates.length ? rates : [trimmed];
}

/** The same rates on one line, for the text under the title. */
export function priceChip(value: string): string {
  return priceChips(value).join(" · ");
}
