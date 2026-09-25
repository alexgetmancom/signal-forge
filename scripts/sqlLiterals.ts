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
