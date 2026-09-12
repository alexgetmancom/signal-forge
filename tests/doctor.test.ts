import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { backupStatus, doctorReport } from "../src/doctor.js";
import { listActionableIssues } from "../src/issues.js";
import { openDatabase } from "../src/storage/database.js";

const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
const NOW = Date.parse("2026-09-12T18:00:00.000Z");

function backupDirectory(marker?: Record<string, unknown>): string {
  const directory = mkdtempSync(join(tmpdir(), "signal-forge-backups-"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "app-20260912-030000.db.gz"), "archive");
  if (marker) writeFileSync(join(directory, "last-verified.json"), JSON.stringify(marker));
  return directory;
}

test("a backup is current only when the job verified one recently", () => {
  const fresh = backupDirectory({
    verifiedAt: "2026-09-12T03:00:00.000Z",
    file: "app-20260912-030000.db.gz",
    bytes: 1024,
    events: 4200,
  });
  expect(backupStatus(fresh, NOW)).toMatchObject({ ok: true, state: "fresh", archives: 1, events: 4200 });

  // An archive nobody verified is a file, not a backup, and a job that stopped leaves one behind.
  const unverified = backupDirectory();
  expect(backupStatus(unverified, NOW)).toMatchObject({ ok: false, state: "unverified", archives: 1 });

  const stale = backupDirectory({
    verifiedAt: "2026-09-08T03:00:00.000Z",
    file: "app-20260908-030000.db.gz",
    bytes: 1024,
    events: 4000,
  });
  expect(backupStatus(stale, NOW)).toMatchObject({ ok: false, state: "stale" });
  expect(backupStatus(join(stale, "absent"), NOW)).toMatchObject({ ok: false, state: "missing", archives: 0 });
  for (const directory of [fresh, unverified, stale]) rmSync(directory, { recursive: true, force: true });
});

test("a backup that stopped becomes an operator issue rather than staying silent", () => {
  const db = openDatabase(":memory:");
  const directory = backupDirectory();
  const config = loadConfig({ CONFIG_PATH: configPath, BACKUP_DIRECTORY: directory });
  expect(doctorReport(config, NOW)).toMatchObject({ ok: false, required: { backupVerified: false } });
  expect(listActionableIssues(db, config, NOW).find((issue) => issue.id === "backup:stale")).toMatchObject({
    kind: "backup_stale",
    severity: "critical",
  });
  rmSync(directory, { recursive: true, force: true });
  db.close();
});
