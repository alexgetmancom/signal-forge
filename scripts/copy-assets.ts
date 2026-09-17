import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

// tsc emits JavaScript only; files the code reads beside itself are copied after it. The build
// replaces each directory rather than adding to it: a file left behind by an earlier build is still
// read, and a stale migration makes the journal longer than the version the code expects.
for (const directory of ["storage/migrations", "events/render/logos"]) {
  const source = fileURLToPath(new URL(`../src/${directory}/`, import.meta.url));
  const target = fileURLToPath(new URL(`../dist/src/${directory}/`, import.meta.url));
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true });
}
