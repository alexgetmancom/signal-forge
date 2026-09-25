/**
 * What a new model is weighed by, and where it can be called.
 *
 * Context, price and what it accepts, cut to the three pills a picture holds, plus the rules for a
 * launch nobody has claimed: which venue leads, which of the venue's own bookkeeping is not a fact
 * about the model, and which numbers may be borrowed from another catalogue when the maker's own
 * row carries neither. Moved out of discord.ts unchanged.
 */
import { isStealthLaunch, listsAnotherMakersModel, stealthSubject } from "../signals.js";
import type { Event } from "../types.js";
import { type Fact, prices } from "./common.js";
import type { CardContext } from "./facts.js";
import { priceChip, priceChips } from "./price.js";
import { place } from "./words.js";

/**
 * A model its own maker has put in its own catalogue: the moment a release is real, and the card
 * that gets screenshotted. A reseller listing the same model is availability, not the launch.
 */
export function isLaunch(event: Event, vendor: string): boolean {
  // A stealth model has no maker to put it in its own catalogue: whoever lists it first is the
  // launch, and the reader can call it that hour.
  if (isStealthLaunch(event)) return true;
  return (
    event.kind === "new" && event.stream === "api-models" && vendor !== "Unknown" && !listsAnotherMakersModel(event)
  );
}

/** The venue's name for a stealth model, capitalised as a model: `space-bunny-free` is Space Bunny. */
export function stealthName(event: Event): string {
  return stealthSubject(event)
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => (/^\d/.test(word) ? word : `${word.charAt(0).toUpperCase()}${word.slice(1)}`))
    .join(" ");
}

/**
 * What a stealth card is read for: that it is free, how much context it takes and what it accepts.
 * The venue's own bookkeeping -- a `headline` flag for its shop window, the family name already in
 * the title -- is not a fact about the model.
 */
export const STEALTH_NOISE = new Set(["model", "maker", "free", "headline", "name", "id"]);

/**
 * A venue's own bookkeeping, on any card it produced. OpenCode Zen listing Claude Opus 5.5 carried
 * "free: no", "headline: no" and "Model: claude-opus-5-5": a shop-window flag, its opposite, and
 * the ID already printed under the title. Only a stealth card was cleaned of these, and every other
 * card from the same shelf carried them.
 */
export const VENUE_NOISE = new Set(["model", "headline", "free"]);

export const VENUES = new Set(["opencode-zen", "opencode-go", "command-code-models"]);

/**
 * Where a stealth model can be called, best venue first.
 *
 * Space Bunny reached OpenCode Go two seconds before Zen and the card named Go, which is the paid
 * client; Zen is the free endpoint, and free is the whole reason this is news. A reseller giving it
 * away comes next, and the rest of the venues go in the line underneath.
 */
const VENUE_ORDER = ["opencode-zen", "openrouter", "opencode-go"];

/**
 * What a stealth card is read for, in the order a reader weighs it: that it costs nothing, how much
 * it holds, and what it takes. Three pills is what the picture has room for.
 */
export function stealthChips(event: Event & CardContext, found: readonly string[]): string[] {
  const borrowed = event.borrowed ?? {};
  const record = (event.after_json ? JSON.parse(event.after_json) : {}) as Record<string, unknown>;
  const context = found.find((chip) => chip.endsWith("context")) ?? contextChip(borrowed.context);
  const accepts = [record.input, borrowed.input].find(Array.isArray);
  return ["free", ...(context ? [context] : []), ...(accepts ? [accepts.join(", ")] : [])].slice(0, 3);
}

/**
 * The two numbers a launch is weighed by, filled in from another catalogue when the maker's own row
 * carries neither. Claude Opus 5.5 went out with an empty bottom half while OpenRouter held both.
 */
export function launchChips(event: Event & CardContext, found: readonly string[]): string[] {
  const borrowed = event.borrowed ?? {};
  const chips = [...found];
  if (!chips.some((chip) => chip.endsWith("context"))) {
    const context = contextChip(borrowed.context);
    if (context) chips.push(context);
  }
  if (!chips.some((chip) => chip.includes("$"))) {
    const price = prices(null, borrowed.pricing, String(borrowed.pricingSource ?? "openrouter")).find(
      (fact): fact is Exclude<Fact, string> => typeof fact !== "string" && fact.label === "Price",
    );
    if (price) chips.push(...priceChips(price.value));
  }
  return chips.slice(0, 3);
}

/** A borrowed context length as the picture says it: 1048576 tokens is "1M context". */
function contextChip(value: unknown): string | null {
  const tokens = Number(value);
  if (!Number.isFinite(tokens) || tokens < 1000) return null;
  return `${tokens >= 1_000_000 ? `${Math.round(tokens / 1_000_000)}M` : `${Math.round(tokens / 1000)}K`} context`;
}

/** The light on a card with no maker on it. */

export function stealthVenues(event: Event & CardContext): { headline: string; others: string[]; source: string } {
  const sources = [...new Set([event.source, ...(event.elsewhere ?? [])])].sort((one, two) => {
    const rank = (source: string) => {
      const at = VENUE_ORDER.indexOf(source);
      return at === -1 ? VENUE_ORDER.length : at;
    };
    return rank(one) - rank(two);
  });
  const first = sources[0] ?? event.source;
  return { headline: place(first), others: sources.slice(1).map(place), source: first };
}

/** Context and price, the two numbers a reader weighs a new model by, lifted out of the fields. */
export function specLine(facts: Fact[]): { line: string | null; chips: string[]; rest: Fact[] } {
  const pick = (label: string) =>
    facts.find((fact): fact is Exclude<Fact, string> => typeof fact !== "string" && fact.label === label);
  const context = pick("Context");
  const price = pick("Price");
  // How much a model can write back is part of its shape, and it went out as a field of its own
  // reading "Returns 131072": a raw token count, in a row by itself, under a line about the shape.
  const returns = pick("Returns");
  const out = returns ? tokenCount(returns.value) : null;
  const chips = [
    ...(context ? [`${context.value} context`] : []),
    ...(out ? [`${out} out`] : []),
    // The picture holds three short pills. GPT-6 Sol's four rates ran off the edge of one; what a
    // reader weighs a model by is what it costs in and out, and the cache rates stay in the text.
    ...(price ? priceChips(price.value) : []),
  ].slice(0, 3);
  const line = [
    ...(context ? [`**${context.value}** context`] : []),
    ...(out ? [`**${out}** out`] : []),
    // The same two rates the pill carries. Four of them in a row -- in, out, cache read, cache
    // write -- is a table laid end to end, and nobody picks a model by its cache write price.
    ...(price ? [`**${priceChip(price.value)}** per 1M tokens`] : []),
  ].join(" · ");
  return {
    line: line || null,
    chips,
    rest: facts.filter((fact) => fact !== context && fact !== price && !(out && fact === returns)),
  };
}

/** A token count as a reader says it: 131072 is "128K", 1050000 is "1.05M". */
function tokenCount(value: string): string | null {
  const amount = Number(String(value).replace(/[,_\s]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (amount >= 1_000_000) return `${Number((amount / 1_000_000).toFixed(2))}M`;
  if (amount >= 1000) return `${amount % 1024 === 0 ? amount / 1024 : Math.round(amount / 1000)}K`;
  return String(amount);
}
