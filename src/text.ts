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

/**
 * How a result is printed, which is the surface's business and not the registry's.
 *
 * Indented JSON is right for a person reading one record and wrong for forty rows of five columns:
 * an agent answering a question from it pipes it through `grep` and `paste` to get back the table
 * it started with, every time, and pays for the punctuation in between. `--tsv` prints rows as a
 * header and tab-separated lines. Anything that is not a list of rows is still JSON, because for
 * a nested answer the punctuation is the meaning.
 */
export function asTsv(value: unknown): string | null {
  const rows = (value as { rows?: unknown })?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row as Record<string, unknown>)))];
  const cell = (row: unknown, column: string): string => {
    const raw = (row as Record<string, unknown>)[column];
    if (raw === null || raw === undefined) return "";
    const text = typeof raw === "object" ? JSON.stringify(raw) : String(raw);
    return text.replaceAll("\t", " ").replaceAll("\n", " ");
  };
  return [columns.join("\t"), ...rows.map((row) => columns.map((column) => cell(row, column)).join("\t"))].join("\n");
}
