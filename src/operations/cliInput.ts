import { cliFieldName } from "../guide.js";
import type { OperationMap } from "./definition.js";

/** Read the CLI's positional and named arguments without silently discarding an operator's input. */
export function cliInput(defs: OperationMap, name: string, argv: readonly string[]): Record<string, unknown> {
  const definition = defs[name];
  if (!definition?.cli) throw new Error(`No CLI command: ${name}`);
  const args = definition.cli.args ?? [];
  const fields = definition.schema.shape;
  const flags = new Map(Object.keys(fields).map((field) => [cliFieldName(field), field]));
  const input: Record<string, unknown> = {};
  const positional: string[] = [];
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] as string;
    if (!positionalOnly && token === "--") {
      positionalOnly = true;
      continue;
    }
    if (positionalOnly || !token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const equals = token.indexOf("=");
    const spelling = token.slice(2, equals < 0 ? undefined : equals);
    const field = flags.get(spelling);
    if (!field)
      throw new Error(
        `Unknown option --${spelling}. Available: ${[...flags.keys()].map((key) => `--${key}`).join(", ") || "none"}`,
      );
    if (field in input) throw new Error(`Option --${spelling} was given twice`);
    if (equals >= 0) {
      input[field] = token.slice(equals + 1);
      continue;
    }

    const schema = fields[field];
    const trueValue = schema?.safeParse("true");
    const falseValue = schema?.safeParse("false");
    const switchField =
      trueValue?.success && trueValue.data === true && falseValue?.success && falseValue.data === false;
    const next = argv[index + 1];
    if (switchField && (next === undefined || !["true", "false", "1", "0", "yes", "no"].includes(next))) {
      input[field] = true;
    } else {
      if (next === undefined || next.startsWith("--")) throw new Error(`Option --${spelling} needs a value`);
      input[field] = next;
      index++;
    }
  }

  for (const [index, argument] of args.entries()) {
    const value = argument.rest ? positional.slice(index).join("/") : positional[index];
    if (value === undefined || value === "") continue;
    if (argument.name in input)
      throw new Error(`Argument ${cliFieldName(argument.name)} was given both positionally and as an option`);
    input[argument.name] = value;
  }
  if (!args.at(-1)?.rest && positional.length > args.length)
    throw new Error(`Unexpected argument: ${positional[args.length]}`);
  return input;
}
