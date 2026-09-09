import { readMigrations, validateMigrationSequence } from "../src/storage/migrations.js";

const migrations = readMigrations();
validateMigrationSequence(migrations);
process.stdout.write(`Migration integrity passed: ${migrations.length} ordered files.\n`);
