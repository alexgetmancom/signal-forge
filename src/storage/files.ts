import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Owner-only, for anything a leak would compromise: tokens, refreshed credentials, session state. */
export const SECRET_MODE = 0o600;

/**
 * Write through a temporary file and rename into place: a crash mid-write leaves the previous
 * contents intact instead of a truncated file. The rename is atomic within one filesystem.
 */
export function writeTextAtomic(path: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    // The mode is set on the temporary file too, so the secret is never briefly world-readable.
    writeFileSync(temporary, text, { encoding: "utf8", mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // A successful rename already removed it.
    }
  }
}

export function writeJsonAtomic(path: string, data: unknown, mode = 0o644): void {
  writeTextAtomic(path, `${JSON.stringify(data, null, 2)}\n`, mode);
}

export function writeSecretJson(path: string, data: unknown): void {
  writeJsonAtomic(path, data, SECRET_MODE);
}
