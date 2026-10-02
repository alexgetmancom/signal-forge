/**
 * Fold the migrations production has already run into one baseline file.
 *
 *   bun run squash-migrations              everything up to the version on origin/main
 *   bun run squash-migrations 70           everything up to a version you name
 *   bun run squash-migrations --dry-run    say what it would do and write nothing
 *
 * The journal is a baseline and the migrations that came after it, and a migration is only ever
 * needed again by a database that has not run it. Once main declares a version, production holds
 * it, so the files up to it are what every new database and every test replays for nothing. This
 * replaces them with one file numbered for that version -- production, already stamped with it, has
 * nothing to run -- and keeps whatever is above it, which is what has not shipped yet.
 *
 * `squashMigrations.ts` does the work and the proof: it replays the old journal and the new one and
 * writes nothing unless the two schemas are the same.
 */
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { readMigrations } from "../src/storage/migrations.js";
import { deployedSchemaVersion } from "./deployedVersion.js";
import { squash } from "./squashMigrations.js";

const directory = `${import.meta.dir}/../src/storage/migrations`;
const dryRun = Bun.argv.includes("--dry-run");
const named = Bun.argv.slice(2).find((argument) => !argument.startsWith("--"));

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const through = named === undefined ? deployedSchemaVersion() : Number(named);
if (through === null || !Number.isInteger(through))
  fail("origin/main could not be read, so say which version production holds: bun run squash-migrations <version>");

let result: ReturnType<typeof squash>;
try {
  result = squash(readMigrations(), through);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

process.stdout.write(
  `${named === undefined ? "origin/main declares" : "squashing through"} version ${through}: ` +
    `${result.replaces.length} files become ${result.filename}` +
    `${result.kept.length ? `, ${result.kept.length} above it stay (${result.kept.map((one) => one.filename).join(", ")})` : ""}.\n` +
    "The old journal and the new one were replayed and produce the same schema.\n",
);
if (dryRun) process.exit(0);

for (const old of result.replaces) rmSync(`${directory}/${old.filename}`);
writeFileSync(`${directory}/${result.filename}`, result.sql);
process.stdout.write(
  `Wrote ${readdirSync(directory).length} files. Before pushing: confirm production holds ${through} ` +
    '(`bun run prod sql "SELECT user_version FROM pragma_user_version"`), then `bun run rehearse --only migration`.\n',
);
