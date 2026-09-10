let production = false;
export function configureLogger(isProduction: boolean): void {
  production = isProduction;
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

  if (production) {
    const payload: Record<string, unknown> = { timestamp, level, message };
    if (safeDetails !== undefined) payload.details = safeDetails;
    console.log(redactExternalSecrets(JSON.stringify(payload)));
    return;
  }

  const suffix = safeDetails === undefined ? "" : ` ${redactExternalSecrets(JSON.stringify(safeDetails))}`;
  const output = `[${timestamp}] [${level.toUpperCase()}] ${redactExternalSecrets(message)}${suffix}`;
  if (level === "error") console.error(output);
  else console.log(output);
}
