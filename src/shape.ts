/**
 * The structure of an upstream answer, with none of its content.
 *
 * Diagnosing `arena` on 2026-09-25 took a live fetch of the page, because nothing here could say
 * what the answer used to look like. The body of a failed parse is deliberately never stored -- it
 * is somebody else's data and it carries signed URLs -- and that rule is right, but it left the
 * comparison impossible: "the response changed" could only ever be a guess.
 *
 * A shape is the paths and the types and nothing else. `initialModels[].rank: number` is a fact
 * about the contract; `1083` models is a fact about the contract too, and is kept as a count.
 * Neither is a value. An object with more keys than a schema would name is collapsed to `{*}`,
 * because at that width the keys are the data -- a map from model ID to its row -- rather than the
 * shape of it.
 */

/** Deep enough for any contract worth naming, shallow enough that a 21MB page is cheap to walk. */
const MAX_DEPTH = 6;
/** Past this many paths the answer is a data structure being described, not a contract. */
const MAX_PATHS = 300;
/** Enough array entries to see an optional field, few enough to stay cheap. */
const SAMPLED_ENTRIES = 20;
/** More keys than this and the keys are values: a map keyed by model ID, not a record type. */
const KEYS_ARE_DATA = 40;

export type Shape = {
  /** Path to the type at it, sorted. `models[].pricing.input: number`. */
  paths: Record<string, string>;
  /** How many entries each array path held this time. The only number kept, and never a value. */
  counts: Record<string, number>;
};

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function shapeOf(value: unknown): Shape {
  const paths: Record<string, string> = {};
  const counts: Record<string, number> = {};
  const walk = (node: unknown, path: string, depth: number): void => {
    if (Object.keys(paths).length >= MAX_PATHS) return;
    const kind = typeName(node);
    if (kind === "array") {
      const entries = node as unknown[];
      counts[path || "."] = entries.length;
      paths[`${path}[]`] = entries.length ? "array" : "array(empty)";
      if (depth >= MAX_DEPTH) return;
      for (const entry of entries.slice(0, SAMPLED_ENTRIES)) walk(entry, `${path}[]`, depth + 1);
      return;
    }
    if (kind === "object") {
      const keys = Object.keys(node as Record<string, unknown>);
      if (keys.length > KEYS_ARE_DATA) {
        paths[`${path}{*}`] = "object";
        counts[`${path}{*}`] = keys.length;
        // One entry is enough to describe what the map holds, and its key is not recorded.
        if (depth < MAX_DEPTH) walk((node as Record<string, unknown>)[keys[0] as string], `${path}{*}`, depth + 1);
        return;
      }
      if (depth >= MAX_DEPTH) {
        paths[path] = "object";
        return;
      }
      for (const key of keys.sort())
        walk((node as Record<string, unknown>)[key], path ? `${path}.${key}` : key, depth + 1);
      return;
    }
    paths[path || "."] = kind;
  };
  walk(value, "", 0);
  return {
    paths: Object.fromEntries(Object.entries(paths).sort(([left], [right]) => (left < right ? -1 : 1))),
    counts,
  };
}

/** The identity of a contract: its paths and types, never its counts. A roster of 61 and one of
 * 1083 are the same shape, which is what makes the count worth keeping separately. */
export function shapeHash(shape: Shape): string {
  const text = Object.entries(shape.paths)
    .map(([path, type]) => `${path}:${type}`)
    .join("\n");
  return Bun.hash(text).toString(16);
}
