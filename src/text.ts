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
