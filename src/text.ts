/** Shared string normalization. Kept in one place because the identity of a record depends on it. */

/** A URL- and id-safe form of a human label. */
export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** A trimmed string, or null when the value is absent, blank or not a string. */
export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The first `limit` UTF-16 units without cutting a character in half. A plain slice can end between
 * the two halves of an emoji, and a lone surrogate is text Discord may refuse outright.
 */
export function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const end = /[\uD800-\uDBFF]/.test(value[limit - 1] ?? "") ? limit - 1 : limit;
  return value.slice(0, end);
}
