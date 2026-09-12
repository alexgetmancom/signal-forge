import { loadConfig } from "./config.js";
import { recordOperatorAction } from "./journal.js";
import { cliCommand, type OperationMap, operationCatalog, operations } from "./operations.js";
import { measure } from "./runtime/metrics.js";
import { openDatabase } from "./storage/database.js";

/**
 * The dispatch is generic: every command, its arguments, its usage line and whether it is a
 * mutation come from the registry. The previous chain of branches and its hand-written usage
 * string had already drifted apart, which is the failure this shape cannot have.
 */
function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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

/** Positional arguments are named by the registry; the schema coerces them from text. */
function cliInput(defs: OperationMap, name: string, argv: readonly string[]): Record<string, unknown> {
  const args = defs[name]?.cli?.args ?? [];
  const input: Record<string, unknown> = {};
  args.forEach((argument, index) => {
    const value = argument.rest ? argv.slice(index).join("/") : argv[index];
    if (value !== undefined && value !== "") input[argument.name] = value;
  });
  return input;
}

const config = loadConfig(),
  db = openDatabase(config.DATABASE_URL);
try {
  const defs = operations(db, config);
  const byCommand = new Map(Object.keys(defs).map((name) => [cliCommand(name), name]));
  const command = Bun.argv[2] ?? "status";
  const name = byCommand.get(command);
  if (!name || !defs[name]?.cli) {
    process.stderr.write(`${usage(defs)}\n`);
    process.exitCode = command === "help" || command === "--help" ? 0 : 1;
  } else {
    const definition = defs[name];
    const input = definition.schema.safeParse(cliInput(defs, name, Bun.argv.slice(3)));
    if (!input.success) {
      process.stderr.write(
        `${input.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("\n")}\n`,
      );
      if (definition.mutates)
        recordOperatorAction(db, { surface: "cli", operation: name, input: {}, outcome: "rejected" });
      process.exitCode = 1;
    } else {
      // A mutation says so before it runs: the operator asked for it, and the journal will carry it.
      if (definition.mutates) process.stderr.write(`This command changes stored state: ${name}\n`);
      await measure(db, `cli.command:${command}`, async () => {
        try {
          const result = await (definition.handler as (value: unknown) => unknown)(input.data);
          if (definition.mutates)
            recordOperatorAction(db, { surface: "cli", operation: name, input: input.data, outcome: "ok" });
          write(result ?? null);
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Operation failed";
          if (definition.mutates)
            recordOperatorAction(db, { surface: "cli", operation: name, input: input.data, outcome: "failed", detail });
          process.stderr.write(`${detail}\n`);
          process.exitCode = 1;
        }
      });
    }
  }
} finally {
  db.close();
}
