import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CURRENT_SCHEMA_VERSION = 43;

export type Migration = {
  version: number;
  name: string;
  filename: string;
  sql: string;
};

function migrationDirectory(): string {
  return fileURLToPath(new URL("./migrations/", import.meta.url));
}

export function readMigrations(directory = migrationDirectory()): Migration[] {
  const migrations = readdirSync(directory)
    .filter((filename) => filename.endsWith(".sql"))
    .map((filename) => {
      const match = /^(\d{3})_([a-z0-9_]+)\.sql$/.exec(filename);
      if (!match) throw new Error(`Invalid migration filename: ${filename}`);
      return {
        version: Number(match[1]),
        name: match[2] ?? filename,
        filename,
        sql: readFileSync(`${directory}/${filename}`, "utf8"),
      };
    })
    .sort((left, right) => left.version - right.version);
  validateMigrationSequence(migrations);
  return migrations;
}

/**
 * The journal is a baseline file and the migrations that came after it. It does not start at 1:
 * the baseline is numbered for the version it produces, so a database already holding that version
 * has nothing to run, and a new one reaches it in a single step.
 */
export function validateMigrationSequence(migrations: readonly Migration[]): void {
  if (!migrations.length) throw new Error("No migrations found");
  migrations.forEach((migration, index) => {
    const previous = migrations[index - 1];
    if (!previous) return;
    if (migration.version === previous.version) throw new Error(`Duplicate migration number: ${migration.version}`);
    if (migration.version !== previous.version + 1)
      throw new Error(
        `Migration sequence has a gap or wrong order: expected ${previous.version + 1}, got ${migration.version}`,
      );
  });
  const latest = migrations[migrations.length - 1]?.version;
  if (latest !== CURRENT_SCHEMA_VERSION)
    throw new Error(`Migration journal version ${CURRENT_SCHEMA_VERSION} does not match files ${latest}`);
}

/**
 * The statements of a migration, one at a time.
 *
 * Handing a whole script to `exec` is how a migration loses a table without saying so: a statement
 * that fails a constraint at run time - a CHECK, a NOT NULL, a UNIQUE - is skipped rather than
 * raised when any statement follows it, and every table rebuild here is a copy followed by a drop.
 * The copy would be refused, the drop would take the original, and the migration would report
 * success. Only a parse error stops a script. Run one statement at a time and every failure is a
 * failure.
 *
 * Splitting respects the two places a semicolon means nothing: inside a quoted string, and after
 * `--` on a line of its own.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quoted = false;
  let commented = false;
  for (let index = 0; index < sql.length; index++) {
    const character = sql[index] ?? "";
    if (commented) {
      commented = character !== "\n";
    } else if (quoted) {
      // '' inside a string is an escaped quote, not the end of one, and both halves of it belong
      // to the statement.
      if (character === "'" && sql[index + 1] === "'") {
        current += character;
        index++;
      } else if (character === "'") {
        quoted = false;
      }
    } else if (character === "'") {
      quoted = true;
    } else if (character === "-" && sql[index + 1] === "-") {
      commented = true;
    } else if (character === ";" && !insideTriggerBody(current)) {
      if (meaningful(current)) statements.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (meaningful(current)) statements.push(current.trim());
  return statements;
}

/**
 * A trigger body holds its own statements, so the semicolons inside it belong to the trigger and
 * not to the journal. The body runs from `BEGIN` to the `END` that closes it, which is the one
 * immediately before the terminating semicolon.
 */
function insideTriggerBody(statement: string): boolean {
  return /\bCREATE\s+TRIGGER\b/i.test(statement) && /\bBEGIN\b/i.test(statement) && !/\bEND\s*$/i.test(statement);
}

function meaningful(statement: string): boolean {
  return statement.split("\n").some((line) => line.trim() && !line.trim().startsWith("--"));
}
