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
 * it started with, every time, and pays for the punctuation in between. `--tsv` prints that table.
 *
 * It used to look only at `value.rows`, which is the shape `sql` answers in and nothing else does.
 * So the flag worked for one command out of fifty-seven while the guide said "any command takes
 * `--tsv`" -- and the reports anybody actually reads, `broken` and `usage` and `flaky`, silently
 * came back as JSON. A report's table is an array of objects somewhere inside it; this finds the
 * biggest one and names it, because which array was chosen is part of the answer.
 */
type Table = { name: string; rows: Record<string, unknown>[] };

/** Every array of objects in the answer, with the path that leads to it. Depth-first, shallow first. */
function tablesWithin(value: unknown, path: string, depth = 0): Table[] {
  if (depth > 3 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    const rows = value.filter(
      (entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object" && !Array.isArray(entry),
    );
    return rows.length === value.length && rows.length > 0 ? [{ name: path, rows }] : [];
  }
  return Object.entries(value).flatMap(([key, nested]) =>
    tablesWithin(nested, path ? `${path}.${key}` : key, depth + 1),
  );
}

function render(rows: Record<string, unknown>[]): string {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const cell = (row: Record<string, unknown>, column: string): string => {
    const raw = row[column];
    if (raw === null || raw === undefined) return "";
    const value = typeof raw === "object" ? JSON.stringify(raw) : String(raw);
    return value.replaceAll("\t", " ").replaceAll("\n", " ");
  };
  return [columns.join("\t"), ...rows.map((row) => columns.map((column) => cell(row, column)).join("\t"))].join("\n");
}

/**
 * The answer as one tab-separated table, or null when there is no array of rows in it at all.
 *
 * With no path named, the largest array wins and the ones it beat are listed above it, so the flag
 * always produces something and never silently produces the wrong thing: everything outside the
 * chosen table is dropped, and the comment line says what was dropped. `--tsv=now.issues` picks a
 * particular one, which is what the comment line exists to make possible.
 */
export function asTsv(value: unknown, path?: string): string | null {
  const tables = tablesWithin(value, "");
  if (tables.length === 0) return null;
  if (path) {
    const named = tables.find((table) => table.name === path);
    return named
      ? render(named.rows)
      : `# no table at ${path}. There is: ${tables.map((table) => table.name).join(", ")}`;
  }
  const chosen = tables.reduce((widest, table) => (table.rows.length > widest.rows.length ? table : widest));
  const others = tables.filter((table) => table !== chosen).map((table) => `${table.name} (${table.rows.length})`);
  const header = others.length === 0 ? [] : [`# ${chosen.name}, not ${others.join(", ")}`];
  return [...header, render(chosen.rows)].join("\n");
}
