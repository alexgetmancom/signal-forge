import type { Database } from "bun:sqlite";
import { CURRENT_SCHEMA_VERSION, readMigrations, splitStatements } from "./migrations.js";

function schemaVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
}

/**
 * Rebuilding a table means creating its replacement, copying the rows across and dropping the
 * original, and SQLite enforces foreign keys during all three: the drop would cascade into every
 * child row, and the window where the name is briefly missing would fail the children that point
 * at it. The documented way through is to turn enforcement off for the migration and ask
 * `foreign_key_check` afterwards whether anything was actually broken - and because the pragma is
 * a no-op inside a transaction, it has to be set around the one the migration runs in.
 *
 * `legacy_alter_table` is the other half, and it is not optional. A rename is supposed to be a
 * rename, but since 3.25 SQLite also rewrites what points at the old name - including the
 * REFERENCES clauses of child tables, which turns `events` into `events_old` in three of them
 * and leaves them pointing at whatever the migration drops. Through 3.51 turning foreign keys
 * off was enough to stop that; 3.53 rewrites regardless, so the schema survived on one SQLite
 * and was quietly broken on the next. The pragma says the rename means only itself, on every
 * version.
 *
 * The statements go in one at a time rather than as one script, because a script hides exactly the
 * failure this schema can produce: see `splitStatements`.
 */
export function runMigrations(db: Database): void {
  const migrations = readMigrations();
  let version = schemaVersion(db);
  if (version > CURRENT_SCHEMA_VERSION)
    throw new Error(`Database schema version ${version} is newer than ${CURRENT_SCHEMA_VERSION}`);
  const pending = migrations.filter((candidate) => candidate.version > version);
  if (pending.length) {
    const enforced = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys ?? 0;
    db.exec("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON");
    try {
      for (const migration of pending) {
        db.transaction(() => {
          for (const statement of splitStatements(migration.sql)) db.run(statement);
          // Inside the transaction, so a migration that orphans a row is rolled back rather than
          // reported after the fact.
          const violations = db.query<{ table: string }, []>("PRAGMA foreign_key_check").all();
          if (violations.length)
            throw new Error(
              `Migration ${migration.filename} left ${violations.length} foreign key violations, in ${[
                ...new Set(violations.map((violation) => violation.table)),
              ].join(", ")}`,
            );
          db.exec(`PRAGMA user_version = ${migration.version}`);
        })();
        version = migration.version;
      }
    } finally {
      db.exec("PRAGMA legacy_alter_table=OFF");
      if (enforced) db.exec("PRAGMA foreign_keys=ON");
    }
  }
  if (version !== CURRENT_SCHEMA_VERSION)
    throw new Error(`Database schema stopped at ${version}, expected ${CURRENT_SCHEMA_VERSION}`);
}
