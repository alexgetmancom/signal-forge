import { loadConfig } from "./config.js";
import { recordOperatorAction } from "./journal.js";
import { cliInput } from "./operations/cliInput.js";
import { cliCommand, type OperationMap, operationCatalog, operations } from "./operations.js";
import { measure } from "./runtime/metrics.js";
import { openDatabase } from "./storage/database.js";
import { asTsv } from "./text.js";

/**
 * The dispatch is generic: every command, its arguments, its usage line and whether it is a
 * mutation come from the registry. The previous chain of branches and its hand-written usage
 * string had already drifted apart, which is the failure this shape cannot have.
 */
function write(value: unknown, tsv: false | { path?: string }): void {
  const table = tsv ? asTsv(value, tsv.path) : null;
  process.stdout.write(table === null ? `${JSON.stringify(value, null, 2)}\n` : `${table}\n`);
}

function usage(defs: OperationMap): string {
  const catalog = operationCatalog(defs).filter((entry) => !entry.usage.startsWith("GET "));
  const width = Math.max(...catalog.map((entry) => entry.usage.length));
  return [
    "Usage: bun src/cli.ts <command> [arguments]",
    "",
    ...catalog.map((entry) => `  ${entry.usage.padEnd(width)}  ${entry.mutates ? "[mutates] " : ""}${entry.summary}`),
    "",
    "Start with `guide` when the command you need is not obvious.",
  ].join("\n");
}

// `--tsv` is the largest table in the answer; `--tsv=<path>` is the one named, and the comment
// line the first form prints is where the paths come from.
const tsvArgument = Bun.argv.find((value) => value === "--tsv" || value.startsWith("--tsv="));
const tsv = tsvArgument ? { ...(tsvArgument.includes("=") ? { path: tsvArgument.split("=")[1] } : {}) } : false;
const argvWithoutFlags = Bun.argv.filter((value) => value !== tsvArgument);
const config = loadConfig();
// Outside the container this is a local copy, and a question about what the service saw is almost
// never a question about it. stderr, so stdout stays parseable.
if (config.NODE_ENV !== "production")
  process.stderr.write(
    `Local database (${config.DATABASE_URL}), not production. For production: bun run prod ${Bun.argv.slice(2).join(" ") || "<command>"}\n`,
  );
const db = openDatabase(config.DATABASE_URL);
try {
  const defs = operations(db, config);
  const byCommand = new Map(Object.keys(defs).map((name) => [cliCommand(name), name]));
  const command = argvWithoutFlags[2] ?? "status";
  const name = byCommand.get(command);
  if (!name || !defs[name]?.cli) {
    process.stderr.write(`${usage(defs)}\n`);
    // A name that is not a command is the clearest signal the registry can get: somebody expected
    // this command to exist. Recorded under the name that was asked for, so `usage` lists the
    // guesses next to the commands, and a guess made repeatedly is a command worth writing.
    if (command !== "help" && command !== "--help")
      recordOperatorAction(db, {
        surface: "cli",
        operation: command,
        input: {},
        outcome: "rejected",
        mutates: false,
        detail: "No such command",
      });
    process.exitCode = command === "help" || command === "--help" ? 0 : 1;
  } else {
    const definition = defs[name];
    const input = definition.schema.safeParse(cliInput(defs, name, argvWithoutFlags.slice(3)));
    if (!input.success) {
      // With the usage line, because the commonest rejection is a missing positional and the schema
      // can only say `expected string, received undefined`: `failures` with no source said that and
      // nothing about there being a source to give it.
      const line = operationCatalog(defs).find((entry) => entry.name === command)?.usage;
      process.stderr.write(
        `${[
          ...input.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`),
          ...(line
            ? [`Usage: ${line}`, `\`guide ${command}\` says what this answers and what the other fields are.`]
            : []),
        ].join("\n")}\n`,
      );
      recordOperatorAction(db, {
        surface: "cli",
        operation: name,
        input: {},
        outcome: "rejected",
        mutates: definition.mutates,
      });
      process.exitCode = 1;
    } else {
      // A mutation says so before it runs: the operator asked for it, and the journal will carry it.
      if (definition.mutates) process.stderr.write(`This command changes stored state: ${name}\n`);
      await measure(db, `cli.command:${command}`, async () => {
        // Every call is journalled, not only the mutations: what an agent asked is the record of
        // which questions the commands could not answer. `mutates` keeps the two kinds apart.
        const started = Bun.nanoseconds();
        const journal = (outcome: "ok" | "failed", detail?: string) =>
          recordOperatorAction(db, {
            surface: "cli",
            operation: name,
            input: input.data,
            outcome,
            mutates: definition.mutates,
            durationMs: (Bun.nanoseconds() - started) / 1e6,
            ...(detail ? { detail } : {}),
          });
        try {
          const result = await (definition.handler as (value: unknown) => unknown)(input.data);
          journal("ok");
          write(result ?? null, tsv);
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Operation failed";
          journal("failed", detail);
          process.stderr.write(`${detail}\n`);
          process.exitCode = 1;
        }
      });
    }
  }
} finally {
  db.close();
}
