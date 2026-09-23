import type { Event } from "../types.js";
import { vendorColor } from "./logos.js";

/**
 * The one place a card's colour is decided.
 *
 * It was decided in three: a nested ternary on the embed's stripe, `glowOf` under the banner and a
 * set of constants inside the number banner. On 2026-09-23 a stealth launch went out with a green
 * stripe over a violet picture, which is what three answers to one question look like. Everything
 * that carries colour now reads this function, and the banner is lit with the stripe's own value.
 */

/** Nobody's brand colour, because nobody has put their name on a stealth model yet. */
const STEALTH_COLOR = 0x8b5cf6;

const KIND_COLORS: Record<Event["kind"], number> = { new: 0x2ecc71, changed: 0xf1c40f, removed: 0xe74c3c };
const RESET_APPLIED = 0x3ddc84;
const DEPRECATION = 0xe67e22;

export type CardLook = {
  /** A status page's own severity, which outranks everything else on the card. */
  incident?: number | null | undefined;
  stream: string;
  kind: Event["kind"];
  /** True for a free model no maker has claimed. */
  stealth?: boolean;
  /** The maker the card is about, as `vendorOf` resolves it. */
  vendor: string;
  /** True where the maker's own colour is the subject: a model's arrival or a sighting's movement. */
  branded?: boolean;
  /** A reset that has already landed is good news and is told in the colour of good news. */
  applied?: boolean;
};

export function cardColor(look: CardLook): number {
  if (look.incident) return look.incident;
  if (look.stealth) return STEALTH_COLOR;
  if (look.stream === "resets" && look.applied) return RESET_APPLIED;
  if (look.stream === "deprecations") return DEPRECATION;
  return (look.branded ? vendorColor(look.vendor) : null) ?? KIND_COLORS[look.kind];
}
