/**
 * The journal has to be internally consistent, and it has to be consistent with the databases that
 * already exist. readMigrations covers the first: contiguous files ending at the declared version.
 *
 * The second is what a deployment finds out the hard way. A database is stamped with the version it
 * reached and the runner refuses anything newer than the code knows, so lowering the declared
 * version - by renumbering, by squashing, by reverting a migration file - tells production it is
 * from the future and stops the release. The number only ever goes up, and the last value pushed to
 * main is what production is running, so that is what this compares against.
 */
import { CURRENT_SCHEMA_VERSION, readMigrations } from "../src/storage/migrations.js";

const migrations = readMigrations();

function deployedVersion(): number | null {
  const show = Bun.spawnSync(["git", "show", "origin/main:src/storage/migrations.ts"]);
  if (!show.success) return null;
  const match = /CURRENT_SCHEMA_VERSION = (\d+)/.exec(show.stdout.toString());
  return match?.[1] ? Number(match[1]) : null;
}

const deployed = deployedVersion();
if (deployed === null) {
  process.stdout.write("Migration integrity passed, but origin/main was unreadable: version not compared.\n");
} else if (CURRENT_SCHEMA_VERSION < deployed) {
  process.stderr.write(
    `Schema version ${CURRENT_SCHEMA_VERSION} is below the ${deployed} already on main.\n` +
      "A database stamped with the higher version reads as newer than this code and refuses to open,\n" +
      "so the deployment would stop at the migration step. Keep the number and add a file above it.\n",
  );
  process.exit(1);
}

process.stdout.write(
  `Migration integrity passed: ${migrations.length} ordered files, version ${CURRENT_SCHEMA_VERSION}` +
    `${deployed === null ? "" : ` at or above the ${deployed} on main`}.\n`,
);
