/**
 * Every word this repository stores or ships is English, and a non-English string reaches a
 * subscriber as a broken card rather than as a translation. The working agreement asked for a grep
 * before every push, which is a rule that survives exactly as long as nobody is busy.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const roots = ["src", "scripts", "tests", "docs"];
const extensions = new Set([".ts", ".sql", ".md", ".sh", ".json"]);
/** Cyrillic, including the supplement: the alphabet this repository keeps writing itself in. */
const cyrillic = /[\u0400-\u04ff\u0500-\u052f]/;

function walk(directory: string, result: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, result);
    else if (entry.isFile() && extensions.has(extname(entry.name))) result.push(path);
  }
  return result;
}

const findings: string[] = [];
let scanned = 0;
for (const name of roots) {
  const directory = join(root, name);
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) continue;
  for (const file of walk(directory)) {
    scanned += 1;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (cyrillic.test(line)) findings.push(`${relative(root, file)}:${index + 1}: ${line.trim().slice(0, 100)}`);
      });
  }
}

if (findings.length) {
  console.error(`Non-English text found:\n${findings.map((finding) => `- ${finding}`).join("\n")}`);
  process.exit(1);
}

console.log(`Language check passed: ${scanned} files are English.`);
