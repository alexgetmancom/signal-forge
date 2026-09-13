import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../src/storage/migrations/", import.meta.url));
const target = fileURLToPath(new URL("../dist/src/storage/migrations/", import.meta.url));
// The build replaces the journal rather than adding to it: a file left behind by an earlier build
// is still read, and a stale one makes the journal longer than the version the code expects.
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
