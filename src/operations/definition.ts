import { z } from "zod";
import { type OperationCatalogEntry, type OperationSection, usageLine } from "../guide.js";

/**
 * One entry per operation, and every operator surface is a projection of it: the CLI dispatch and
 * its usage lines, the HTTP API, the MCP tool list and the guide catalog. Adding an operation is
 * this one entry — the alternative, which this replaced, was four edits and a usage string that
 * had already drifted from the commands it described.
 *
 * `mutates` and `agent` are the two fields that are not documentation. A mutation is journalled on
 * whichever surface it was run from, and `agent: false` keeps an operation out of MCP entirely:
 * every tool is listed in full to an agent before anything is asked, so a read is on because
 * diagnosis is what that surface is for, and a mutation is on only when it is part of routine
 * delivery work. Anything that touches credentials or the host is off regardless.
 */
type CliArgument = { name: string; optional?: boolean; rest?: boolean };

/** What a surface hands the registry: path, query and body, already separated, never parsed. */
type OperationRequest = {
  path: string;
  params: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
  body: unknown;
};

type OperationDefinition = {
  section: OperationSection;
  summary: string;
  /** The question an operator arrives with, when this command is where the answer starts. */
  startHere?: string;
  note?: string;
  mutates: boolean;
  agent: boolean;
  schema: z.ZodType;
  /** Absent means the operation is not on the CLI. */
  cli?: { args?: readonly CliArgument[] };
  /** Absent means the operation is not on the HTTP API. */
  http?: { method: "get" | "post"; path: string; input?: (request: OperationRequest) => unknown };
  /** A handler that answers with nothing is a missing entity, not an empty result. */
  notFoundWhenEmpty?: boolean;
  handler: (input: never) => unknown;
};

export type OperationMap = Record<string, OperationDefinition>;

/** MCP tools are named with underscores; the CLI is spelled the way a shell command is spelled. */
export function cliCommand(name: string): string {
  return name.replaceAll("_", "-");
}

export function operationCatalog(defs: OperationMap): OperationCatalogEntry[] {
  return Object.entries(defs).map(([name, def]) => ({
    name: cliCommand(name),
    usage: def.cli
      ? usageLine(cliCommand(name), def.cli.args ?? [])
      : `${def.http?.method.toUpperCase()} ${def.http?.path}`,
    summary: def.summary,
    section: def.section,
    mutates: def.mutates,
    agent: def.agent,
    ...(def.startHere ? { startHere: def.startHere } : {}),
    ...(def.note ? { note: def.note } : {}),
    ...(def.http ? { http: `${def.http.method.toUpperCase()} ${def.http.path}` } : {}),
  }));
}

/**
 * Run one operation the way a surface runs it: validate the input against its schema, then hand it
 * to the handler. Anything calling an operation directly goes through here, so nothing reaches a
 * handler by a route that skipped its schema.
 */
export function callOperation(defs: OperationMap, name: string, input: unknown = {}): unknown {
  const definition = defs[name];
  if (!definition) throw new Error(`Unknown operation: ${name}. ${nearest(name, Object.keys(defs))}`);
  return (definition.handler as (value: unknown) => unknown)(definition.schema.parse(input));
}

/**
 * A name that was not found, answered with the names that were there.
 *
 * `sql` learned this first and it paid for itself the same day: "no such column: summary" is true
 * and useless, and the version that lists the columns turned five round trips to production into
 * one. Every other "not found" in this repository had the same shape and none of them had the
 * same answer, so this is that lesson as a function: what was asked for, then what exists, closest
 * first. A caller with two hundred known names gets the ones that look like the guess; a caller
 * with eight gets all eight, because a short list is its own suggestion.
 */
export function nearest(asked: string, known: readonly string[], limit = 8): string {
  if (known.length === 0) return "Nothing of that kind exists here yet.";
  const lower = asked.toLowerCase();
  const alike = known.filter((name) => {
    const other = name.toLowerCase();
    return other.includes(lower) || lower.includes(other) || other.slice(0, 3) === lower.slice(0, 3);
  });
  const offer = (alike.length ? alike : known).slice(0, limit);
  return `${alike.length ? "Closest here" : "Here"}: ${offer.join(", ")}${(alike.length ? alike : known).length > limit ? ", ..." : ""}`;
}

/** Query strings and shell arguments arrive as text; MCP sends JSON. Both parse with coercion. */
export const count = (max: number, fallback: number) => z.coerce.number().int().min(1).max(max).default(fallback);
export const identifier = z.coerce.number().int().positive();

/**
 * A switch that arrives as text, read as what it says rather than as whether it was said.
 *
 * `z.coerce.boolean()` is `Boolean(value)`, and every non-empty string is true under it -- so
 * `?all=false` turned the flag on, which is the opposite of the only thing anyone would have meant
 * by typing it. The CLI passes the word, the HTTP query passes the word, and both get the word's
 * meaning. Anything else is a mistake worth reporting rather than guessing at.
 */
export const flag = () =>
  z.union([
    z.boolean(),
    z
      .enum(["true", "false", "1", "0", "yes", "no"])
      .transform((value) => value === "true" || value === "1" || value === "yes"),
  ]);
