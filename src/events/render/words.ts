/**
 * The words every card is written in, and the footer every card ends with.
 *
 * Nothing here knows what an event is. A source becomes a place, a slug becomes a name, a long text
 * becomes an excerpt that ends at a sentence rather than mid-word. They live together because every
 * other module in this folder needs two or three of them, and each one is a rule about how a reader
 * reads rather than about what happened. Moved out of discord.ts unchanged.
 */
import { sourceLabel } from "../../sources/labels.js";
import { versioned } from "../naming.js";

/**
 * A page's name as its maker writes it. The name is recovered from the URL slug, so a page about a
 * model arrived as "Claude opus 5 5": the version lost its dot and the model's name lost its
 * capital. Only a name is capitalised -- few words and a number in it -- because the same slugs
 * carry sentences, and "Claude Discovers Novel Enzyme System" is a headline in a newspaper, not a
 * maker's page.
 */
export function pageName(name: string): string {
  const looksLikeAModel = /\d/.test(name) && name.trim().split(/\s+/).length <= 4;
  const spelled = looksLikeAModel ? name.replace(/(?<=\s)[a-z]/g, (letter) => letter.toUpperCase()) : name;
  return versioned(spelled);
}

export type Detail = "brief" | "evidence";

/** How sure the source is, in the words of someone who does not work here. */
export const TRUST: Record<string, string> = {
  observed: "unconfirmed",
  supported: "the maker's own words",
  confirmed: "confirmed by the provider",
  shipped: "out now",
};

/** A catalogue's name without its section: "Alibaba Model Studio API", "OpenRouter", "PyPI". */
export function place(source: string): string {
  return sourceLabel(source).split(" · ")[0] ?? source;
}

export const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The first sentence or two of a published text, cut at a sentence rather than mid-word. */
export function excerpt(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  // A sentence ends at a stop followed by a space: "gpt-image-2.5-flare" is not two sentences.
  let kept = "";
  for (const sentence of clean.split(/(?<=[.!?])\s+/)) {
    if (`${kept} ${sentence}`.trim().length > limit) break;
    kept = `${kept} ${sentence}`.trim();
  }
  return kept || `${clean.slice(0, limit - 1).trimEnd()}…`;
}

export function present(raw: unknown): boolean {
  return !(raw === null || raw === undefined || raw === "");
}

/** The source a card came from, and for a scout how sure that source is. */
export function footerText(source: string, confidence: string, detail: Detail, caveat?: string): string {
  return [
    sourceLabel(source),
    ...(detail === "evidence" ? [TRUST[confidence] ?? confidence] : []),
    ...(caveat ? [caveat] : []),
  ].join(" · ");
}

/** "OpenCode Go and OpenRouter", the way a sentence lists places. */
export function listed(names: readonly string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function shortDate(value: string, year = false): string {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(year ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
}

/** The opening sentence of a post, which is what a maker leads with. */
export function firstSentence(text: string): string | null {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length < 20) return null;
  const end = clean.search(/[.!?](?:\s|$)/);
  return end > 20 ? clean.slice(0, end + 1) : clean;
}
