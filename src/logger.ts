import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

let production = false;
let directory: string | null = null;
let currentDay = "";

/** Daily files kept beside the database. A month covers any weekly review with room to spare. */
const LOG_RETENTION_DAYS = 30;
const LOG_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * `logDirectory` also writes every line to a daily JSONL file there. The container's own log is
 * rotated at 30 MB and discarded whenever the container is recreated, which every deploy does; a
 * file on the data volume survives both, so a restart can be explained after it happened.
 */
export function configureLogger(isProduction: boolean, logDirectory?: string): void {
  production = isProduction;
  directory = logDirectory ?? null;
  currentDay = "";
  if (directory) mkdirSync(directory, { recursive: true });
}

function pruneLogFiles(dir: string, today: string): void {
  const cutoff = new Date(Date.parse(today) - LOG_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
  for (const name of readdirSync(dir)) {
    const day = LOG_FILE.exec(name)?.[1];
    if (day && day < cutoff) rmSync(join(dir, name), { force: true });
  }
}

/** Synchronous on purpose: the lines that matter most are the last ones before a process is killed. */
function persist(line: string, timestamp: string): void {
  if (!directory) return;
  try {
    const day = timestamp.slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      pruneLogFiles(directory, day);
    }
    appendFileSync(join(directory, `${day}.jsonl`), `${line}\n`);
  } catch {
    // A full or read-only disk must not take the service down with it; stdout still has the line.
  }
}

type LogLevel = "debug" | "info" | "warn" | "error";

const sensitivePatterns = [/token|secret|password|api[_-]?key|authorization|cookie|credential|session/i];

/** Redact credentials embedded in URLs, provider error bodies and free-form exception messages. */
export function redactExternalSecrets(value: string): string {
  return value
    .replace(/(access_token|api[_-]?key|password|token)=([^\s&"']+)/gi, "$1=[REDACTED]")
    .replace(/\/bot\d{6,}:[A-Za-z0-9_-]+/g, "/bot[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
}

/**
 * Every project ends up with secrets the generic pattern cannot know about — a vendor's `ssecurity`
 * field, a signed `download_url`. Register those at startup instead of editing this file downstream.
 */
export function redactKeysMatching(pattern: RegExp): void {
  sensitivePatterns.push(pattern);
}

function isSensitive(key: string): boolean {
  return sensitivePatterns.some((pattern) => pattern.test(key));
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, isSensitive(key) ? "[REDACTED]" : redact(nestedValue)]),
    );
  }
  return value;
}

export function log(level: LogLevel, message: string, details?: unknown): void {
  if (production && level === "debug") return;
  const safeDetails = details === undefined ? undefined : redact(details);
  const timestamp = new Date().toISOString();

  const payload: Record<string, unknown> = { timestamp, level, message };
  if (safeDetails !== undefined) payload.details = safeDetails;
  const line = redactExternalSecrets(JSON.stringify(payload));
  persist(line, timestamp);

  if (production) {
    console.log(line);
    return;
  }

  const suffix = safeDetails === undefined ? "" : ` ${redactExternalSecrets(JSON.stringify(safeDetails))}`;
  const output = `[${timestamp}] [${level.toUpperCase()}] ${redactExternalSecrets(message)}${suffix}`;
  if (level === "error") console.error(output);
  else console.log(output);
}
