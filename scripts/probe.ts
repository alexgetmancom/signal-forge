/**
 * A question that is not worth a command, asked against a copy of production.
 *
 * Every session leaves a trail of throwaway files that each open `new Database(...)`, call
 * `loadConfig()`, work out where the repository root is and then ask one thing. Five of them in one
 * afternoon, all the same eight lines, and every one of them a chance to point at `./data/app.db`
 * -- the stale copy -- and get a confident wrong answer.
 *
 *   bun run probe -e 'db.query("SELECT count(*) AS n FROM events").get()'
 *   bun run probe -e '(await import("../src/reports/broken.js")).brokenReport(db, config).headline'
 *   bun run probe scratch/roster.ts
 *
 * An expression is evaluated in this script's own directory, so a dynamic import inside one reads
 * `../src/...`.
 *
 * A file is a module with a default export taking `{ db, config }`; whatever it returns is printed.
 * An expression is evaluated with `db` and `config` in scope, and awaited if it is a promise.
 *
 * The moment the same probe is run twice it wants to be an operation in `src/operations/` instead:
 * `bun run prod usage` is the thing that notices when it has been.
 *
 * Read-only. The copy is opened `readonly` and production is never touched.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { prodCopy } from "./prodCopy.js";

const root = resolve(import.meta.dir, "..");
const argv = Bun.argv.slice(2);
const flags = new Set(argv.filter((value) => value.startsWith("--")));
const expressionAt = argv.findIndex((value) => value === "-e" || value === "--eval");
const expression = expressionAt >= 0 ? argv[expressionAt + 1] : undefined;
// `expressionAt + 1` is 0 when there is no `-e`, and writing this without the guard silently drops
// the first positional -- which is exactly the bug `rehearse 60` carried for weeks.
const file = argv.find((value, index) => !value.startsWith("-") && !(expressionAt >= 0 && index === expressionAt + 1));

function say(message: string): void {
  process.stderr.write(`${message}\n`);
}

if (!expression && !file) {
  say("usage: bun run probe -e '<expression>' | bun run probe <file.ts>   (db and config are in scope)");
  process.exit(2);
}

const path = await prodCopy(flags.has("--fresh"), say);
if (path === null) {
  say("Could not copy the database, and the local one is stale. A probe answering from it is worse than no probe.");
  process.exit(1);
}

const db = new Database(path, { readonly: true });
const config = loadConfig();

/** Printed the way a terminal wants it: a table if it is rows, JSON if it is anything else. */
function show(value: unknown): void {
  if (value === undefined) return;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object") {
    console.table(value.slice(0, 100));
    if (value.length > 100) say(`... and ${value.length - 100} more`);
    return;
  }
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

try {
  if (expression) {
    // `new Function` rather than `eval` so the expression cannot see this file's own scope by
    // accident: it gets `db` and `config` because they are named here, and nothing else. Async,
    // because the first two things anybody writes here are an `await import(...)` of a report and
    // an `await` of what it returns, and the synchronous form made both of those a `.then` chain.
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (db: Database, config: unknown) => Promise<unknown>;
    const run = new AsyncFunction("db", "config", `return (${expression});`);
    show(await run(db, config));
  } else {
    const resolved = resolve(root, file as string);
    if (!existsSync(resolved)) {
      say(`No such file: ${file}`);
      process.exit(2);
    }
    const module = (await import(resolved)) as { default?: (probe: { db: Database; config: unknown }) => unknown };
    if (!module.default) {
      say(`${file} has no default export. It should be a function taking { db, config }.`);
      process.exit(2);
    }
    show(await module.default({ db, config }));
  }
} finally {
  db.close();
}
