import { cpSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../src/storage/migrations/", import.meta.url));
const target = fileURLToPath(new URL("../dist/src/storage/migrations/", import.meta.url));
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
