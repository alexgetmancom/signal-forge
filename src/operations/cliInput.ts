import type { OperationMap } from "./definition.js";

/**
 * Positional arguments are named by the registry; the schema coerces them from text.
 *
 * Anything else the schema accepts is reachable as `--field value` or `--field=value`, because
 * otherwise it is not reachable at all. The registry projects one operation onto four surfaces, and
 * three of them pass a whole object: HTTP takes query parameters, MCP takes tool arguments. The CLI
 * took a list, so a field with no position was silently dropped -- `suppressions` could not be asked
 * about one channel, `stories` had three filters that did nothing, `journal` could not be narrowed
 * to a command, and `guide` could not be asked for all of itself. No error, just an absent filter.
 */
export function cliInput(defs: OperationMap, name: string, argv: readonly string[]): Record<string, unknown> {
  const args = defs[name]?.cli?.args ?? [];
  const input: Record<string, unknown> = {};
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] as string;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [flag, inline] = token.slice(2).split(/=(.*)/s, 2);
    if (!flag) continue;
    const field = camel(flag);
    // `--flag` with no value is `true`, so a boolean reads the way a flag is expected to; anything
    // that takes a value may still be written either way.
    const next = argv[index + 1];
    if (inline !== undefined) input[field] = inline;
    else if (next !== undefined && !next.startsWith("--")) {
      input[field] = next;
      index++;
    } else input[field] = true;
  }
  args.forEach((argument, index) => {
    if (argument.name in input) return;
    const value = argument.rest ? positional.slice(index).join("/") : positional[index];
    if (value !== undefined && value !== "") input[argument.name] = value;
  });
  return input;
}

/** `--min-confidence` is the same field as `minConfidence`; both spellings reach it. */
function camel(flag: string): string {
  return flag.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}
