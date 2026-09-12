import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AppConfig } from "./config.js";

/**
 * What must be true for this deployment to be doing its job, answered without a story about it.
 *
 * The check that earns this file is the backup one. The nightly job runs on the host, outside this
 * process, and the service has never known whether it still runs. A backup that stopped three
 * weeks ago looks exactly like a backup that ran last night until the day somebody needs it, and
 * the only honest source is the marker the job writes after it has verified the archive it just
 * wrote.
 */
const backupMarkerSchema = z.object({
  verifiedAt: z.string().min(1),
  file: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  events: z.number().int().nonnegative(),
});

export type BackupStatus = {
  ok: boolean;
  state: "fresh" | "stale" | "unverified" | "missing";
  directory: string;
  verifiedAt: string | null;
  ageHours: number | null;
  archives: number;
  file: string | null;
  events: number | null;
  detail: string;
};

/** A nightly job is late once it has missed two nights; one missed night is a restart. */
const BACKUP_MAX_AGE_HOURS = 48;

export function backupStatus(directory: string, now = Date.now()): BackupStatus {
  const base = { directory, verifiedAt: null, ageHours: null, file: null, events: null };
  if (!existsSync(directory))
    return {
      ...base,
      ok: false,
      state: "missing",
      archives: 0,
      detail: `No backup directory at ${directory}; the nightly job has never written here`,
    };
  const archives = readdirSync(directory).filter((name) => name.startsWith("app-") && name.endsWith(".db.gz")).length;
  const markerPath = join(directory, "last-verified.json");
  if (!existsSync(markerPath))
    return {
      ...base,
      ok: false,
      state: "unverified",
      archives,
      detail: `${archives} archive${archives === 1 ? "" : "s"} present, but none has been verified by the backup job`,
    };
  const marker = backupMarkerSchema.safeParse(
    ((): unknown => {
      try {
        return JSON.parse(readFileSync(markerPath, "utf8"));
      } catch {
        return null;
      }
    })(),
  );
  if (!marker.success)
    return {
      ...base,
      ok: false,
      state: "unverified",
      archives,
      detail: "The backup marker is unreadable; treat the last archive as unverified",
    };
  const verifiedAt = Date.parse(marker.data.verifiedAt);
  if (!Number.isFinite(verifiedAt))
    return {
      ...base,
      ok: false,
      state: "unverified",
      archives,
      detail: "The backup marker carries no usable verification time",
    };
  const ageHours = Math.round(((now - verifiedAt) / 3_600_000) * 10) / 10;
  const fresh = ageHours <= BACKUP_MAX_AGE_HOURS;
  return {
    ok: fresh,
    state: fresh ? "fresh" : "stale",
    directory,
    verifiedAt: marker.data.verifiedAt,
    ageHours,
    archives,
    file: marker.data.file,
    events: marker.data.events,
    detail: fresh
      ? `Verified ${ageHours} hours ago with ${marker.data.events} events`
      : `Last verified backup is ${ageHours} hours old; the nightly job has missed at least one night`,
  };
}

export type DoctorReport = {
  ok: boolean;
  required: Record<string, boolean>;
  informational: Record<string, boolean>;
  backup: BackupStatus;
  restoreDrill: string;
};

/**
 * `required` is what a failing deployment fails on; `informational` is configuration an operator
 * may have chosen not to have. Nothing here writes, and nothing here reads a credential value.
 */
export function doctorReport(config: AppConfig, now = Date.now()): DoctorReport {
  const backup = backupStatus(config.BACKUP_DIRECTORY, now);
  const databaseReadable = ((): boolean => {
    if (config.DATABASE_URL === ":memory:") return true;
    try {
      return statSync(config.DATABASE_URL).size > 0;
    } catch {
      return false;
    }
  })();
  const required = {
    databaseReadable,
    backupVerified: backup.ok,
    destinationsConfigured: config.destinations.length > 0,
  };
  const informational = {
    apiTokenConfigured: Boolean(config.MCP_TOKEN),
    alertChannelConfigured: Boolean(config.alertChannelId),
    statusChannelConfigured: Boolean(config.statusChannelId),
  };
  return {
    ok: Object.values(required).every(Boolean),
    required,
    informational,
    backup,
    restoreDrill:
      "An archive is proven by restoring it: decompress the newest archive into a stopped test instance, run integrity_check, start it, and compare event counts against this deployment.",
  };
}
