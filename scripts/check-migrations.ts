import { readMigrations } from "../src/storage/migrations.js";

// readMigrations validates the journal itself; reading it is the check.
const migrations = readMigrations();
process.stdout.write(`Migration integrity passed: ${migrations.length} ordered files.\n`);
