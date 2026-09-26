import { SourceError } from "../failure.js";

/**
 * Named members of a JSON object, each as the text of its value, without parsing the rest.
 *
 * npm's package document is the case this exists for: 15.8 MB for `@openai/codex`, of which
 * `versions` is 15.5 MB -- the full manifest of all 4,959 releases -- while everything this service
 * reads from it is `name`, `dist-tags` and `time`, together 265 KB. `JSON.parse` of the whole
 * document adds 39 MB of objects, measured on 2026-09-26 against the stored body, and the process
 * does not give that back afterwards.
 *
 * So the document is scanned rather than parsed: byte by byte at the top level, tracking strings and
 * their escapes so a brace inside a value is not mistaken for structure, and each requested member
 * handed back as the slice of text it occupies. The caller parses those slices, which is where a
 * schema still has its say. The scan allocates nothing but the slices asked for and stops as soon as
 * they have all been found.
 *
 * This is not a JSON parser and does not pretend to be one: it answers about the top level of an
 * object, and a member it never finds is simply absent from the result.
 */
export function jsonMembers(payload: string, keys: readonly string[]): Record<string, string> {
  const wanted = new Set(keys);
  const found: Record<string, string> = {};
  let at = skipSpace(payload, 0);
  if (payload[at] !== "{") throw new SourceError("protocol", "Source answered with no JSON object");
  at = skipSpace(payload, at + 1);
  while (at < payload.length && payload[at] !== "}") {
    if (payload[at] !== '"') throw new SourceError("protocol", "Source answered with malformed JSON");
    const keyEnds = endOfString(payload, at);
    const key = payload.slice(at + 1, keyEnds - 1);
    at = skipSpace(payload, keyEnds);
    if (payload[at] !== ":") throw new SourceError("protocol", "Source answered with malformed JSON");
    const valueStarts = skipSpace(payload, at + 1);
    const valueEnds = endOfValue(payload, valueStarts);
    if (wanted.has(key)) {
      found[key] = payload.slice(valueStarts, valueEnds);
      if (Object.keys(found).length === wanted.size) return found;
    }
    at = skipSpace(payload, valueEnds);
    if (payload[at] === ",") at = skipSpace(payload, at + 1);
  }
  return found;
}

function skipSpace(payload: string, from: number): number {
  let at = from;
  while (
    at < payload.length &&
    (payload[at] === " " || payload[at] === "\n" || payload[at] === "\r" || payload[at] === "\t")
  )
    at += 1;
  return at;
}

/** The index just past the closing quote of the string starting at `from`. */
function endOfString(payload: string, from: number): number {
  for (let at = from + 1; at < payload.length; at += 1) {
    if (payload[at] === "\\") {
      at += 1;
      continue;
    }
    if (payload[at] === '"') return at + 1;
  }
  throw new SourceError("protocol", "Source answered with an unterminated JSON string");
}

/** The index just past the value starting at `from`, whatever kind of value it is. */
function endOfValue(payload: string, from: number): number {
  if (payload[from] === '"') return endOfString(payload, from);
  if (payload[from] !== "{" && payload[from] !== "[") {
    let at = from;
    while (at < payload.length && !",}] \n\r\t".includes(payload[at] as string)) at += 1;
    return at;
  }
  let depth = 0;
  for (let at = from; at < payload.length; at += 1) {
    const char = payload[at];
    if (char === '"') {
      at = endOfString(payload, at) - 1;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }
  throw new SourceError("protocol", "Source answered with unbalanced JSON");
}
