/**
 * The SQL written in a TypeScript file, found by scanning rather than by matching.
 *
 * A regular expression over quotes cannot tell a quote inside a string from the end of one, and
 * SQL is full of `'?'`. This walks the file once, skipping comments, and returns every string
 * literal with the line it opened on. Template substitutions become `?`: a fragment spliced into a
 * `WHERE ... IN` is a parameter list by the time it runs, and one spliced anywhere else makes a
 * statement SQLite will refuse to parse, which is how such a statement should be treated.
 */

/** A string literal, and the line its opening quote is on. */
export type Literal = { line: number; value: string };

/** What a statement this repository runs starts with. */
export const STARTS = /^\s*(?:with|select|insert|update|delete|replace)\b/i;

/** Every string literal in a TypeScript file, comments skipped, substitutions reduced to `?`. */
export function literals(text: string): Literal[] {
  const found: Literal[] = [];
  let line = 1;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] as string;
    if (char === "\n") line += 1;
    else if (char === "/" && text[at + 1] === "/") {
      while (at < text.length && text[at] !== "\n") at += 1;
      at -= 1;
    } else if (char === "/" && text[at + 1] === "*") {
      at += 2;
      while (at < text.length && !(text[at] === "*" && text[at + 1] === "/")) {
        if (text[at] === "\n") line += 1;
        at += 1;
      }
      at += 1;
    } else if (char === '"' || char === "'" || char === "`") {
      const opened = line;
      let value = "";
      at += 1;
      while (at < text.length && text[at] !== char) {
        if (text[at] === "\\") {
          value += text[at + 1] === "n" ? "\n" : (text[at + 1] ?? "");
          at += 2;
          continue;
        }
        if (char === "`" && text[at] === "$" && text[at + 1] === "{") {
          let depth = 1;
          at += 2;
          while (at < text.length && depth > 0) {
            if (text[at] === "{") depth += 1;
            else if (text[at] === "}") depth -= 1;
            else if (text[at] === "\n") line += 1;
            at += 1;
          }
          value += "?";
          continue;
        }
        if (text[at] === "\n") line += 1;
        value += text[at];
        at += 1;
      }
      found.push({ line: opened, value });
    }
  }
  return found;
}

/** The tables a statement reads or writes, as SQLite would resolve them. */
export function tablesNamed(sql: string): string[] {
  const normalized = sql
    .replace(/'[^']*'/g, "''")
    .replace(/--[^\n]*/g, " ")
    .toLowerCase();
  return [
    ...new Set(
      [...normalized.matchAll(/\b(?:from|join|into|update)\s+"?([a-z_][\w]*)"?/g)].map((match) => match[1] as string),
    ),
  ];
}

/** A statement with every `json_...()` call cut out, so what is left is what a row actually carries. */
function withoutJsonCalls(sql: string): string {
  let out = "";
  for (let at = 0; at < sql.length; at += 1) {
    const call = /^json_(?:extract|type|valid|array_length|each|quote|group_array)\s*\(/i.exec(sql.slice(at));
    if (!call) {
      out += sql[at];
      continue;
    }
    let depth = 0;
    let index = at + call[0].length - 1;
    for (; index < sql.length; index += 1) {
      if (sql[index] === "(") depth += 1;
      else if (sql[index] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    at = index;
  }
  return out;
}

/**
 * Whether a statement takes the body of more than one event.
 *
 * `*` counts: `SELECT e.*` from `events` carries both bodies and is how most of the reads below ask
 * for them. A lookup keyed on an event's id does not: it answers about one event, which is the
 * shape `event` and `preview` use and the only shape that cannot grow with the archive.
 */
export function readsEventBodies(sql: string): boolean {
  if (!/^\s*(?:select|with)\b/i.test(sql)) return false;
  const bare = withoutJsonCalls(sql);
  const names = /\b(?:before_json|after_json)\b/.test(bare);
  const everything = /\b(?:select|,)\s*(?:[a-z]\w*\.)?\*/i.test(bare) && /\b(?:from|join)\s+events\b/i.test(bare);
  if (!names && !everything) return false;
  return !/\bwhere\s+(?:[a-z]\w*\.)?id\s*=\s*\?/i.test(bare);
}

/**
 * Whether a statement reads `events` with nothing to stop it growing with the archive.
 *
 * Nothing deletes an event, so a read of this table costs whatever the archive has grown to unless
 * something bounds it: a window over a timestamp, a key handed in, an aggregate SQLite answers with
 * one row, or a `LIMIT`. A read with none of those is cheap on the day it is written and there is no
 * moment at which it stops being -- `announcementsBySubject` read every newsroom `new` event ever
 * recorded, 381 rows the day it was found, and one more every time a lab posts.
 *
 * The four ways of being bounded are deliberately generous, because the shapes that are bounded are
 * the shapes to encourage. A window on a story's `updated_at` bounds the events joined to it; a key
 * of any kind -- `se.story_id=?`, `e.id>?` -- bounds the read to what the caller already named.
 */
export function readsEventsUnbounded(sql: string): boolean {
  if (!/^\s*(?:select|with)\b/i.test(sql)) return false;
  const bare = sql.replace(/--[^\n]*/g, " ");
  if (!/\b(?:from|join)\s+events\b/i.test(bare)) return false;
  // A window over any timestamp in the statement, including one on a table the events are joined to.
  if (/\b[a-z_]*_at\s*(?:>=?|<=?)\s*\?/i.test(bare)) return false;
  if (/\b[a-z_]*_at\s+between\s+\?/i.test(bare)) return false;
  // One row out of SQLite rather than the rows that produced it.
  if (/^\s*select\s+(?:max|min|count)\s*\(/i.test(bare)) return false;
  // A key the caller handed in, which is the whole of what the read then costs.
  if (/\b(?:[a-z]\w*\.)?[a-z_]*id\s*(?:=|>=?|<=?)\s*\?/i.test(bare)) return false;
  if (/\b(?:[a-z]\w*\.)?[a-z_]*id\s+in\s*\(\s*\?/i.test(bare)) return false;
  if (/\blimit\b/i.test(bare)) return false;
  return true;
}
