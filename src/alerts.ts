import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { Fetch } from "./http-client.js";
import { type ActionableIssue, type IssueKind, listActionableIssues } from "./issues.js";
import { log } from "./logger.js";
import { measure } from "./runtime/metrics.js";

/**
 * The status board is passive: it shows the truth to whoever opens the channel. A collector that
 * dies quietly can therefore stay dead for days, and silence in the feed reads to subscribers as
 * "nothing is happening" rather than "nothing is being collected". This sends the one message the
 * board cannot: a source went down, and later, a source came back.
 */

/** A source must be down for two consecutive checks before it is announced. */
const CONFIRMATIONS = 2;
/** Above this, the sources are not individually broken — something they share is. */
const PATH_OUTAGE = 4;
const ALERT_STATE_VERSION_KEY = "alert_state_version";
const ALERT_DOWN_KEY = "alert_down";
const ALERT_STRIKES_KEY = "alert_strikes";
/**
 * A problem has to stay gone before it counts as gone.
 *
 * Anthropic's status page answers a poll and then serves a CAPTCHA to the next one, so the same
 * source went down and recovered repeatedly and each swing was announced. Arriving needed two
 * confirmations from the start; leaving needed none, which is where the noise came from.
 */
const ALERT_CLEAR_KEY = "alert_clear_strikes";

function readCounters(db: Database, key: string): Record<string, number> {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM app_state WHERE key=?").get(key);
  try {
    const parsed: unknown = row ? JSON.parse(row.value) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeCounters(db: Database, key: string, counters: Record<string, number>): void {
  const value = JSON.stringify(counters);
  db.query("INSERT INTO app_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=?").run(
    key,
    value,
    value,
  );
}

/**
 * "3 of 3 actionable problems active" told a reader nothing: the two numbers are the same
 * whenever every problem is confirmed, which is most of the time. What is worth saying is how
 * many are being watched but have not been confirmed yet.
 */
function alertFooter(active: number, unconfirmed: number): string {
  const problems = `${active} ${active === 1 ? "problem" : "problems"} active`;
  return unconfirmed > 0 ? `${problems} · ${unconfirmed} seen once, not confirmed` : problems;
}
const alertResponse = z.object({ id: z.string().regex(/^\d+$/) });
const alertableKinds = new Set<IssueKind>([
  "source_failed",
  "collection_degraded",
  "worker_failed",
  "worker_stale",
  "delivery_stuck",
]);

type AlertAttemptStatus = "pending" | "sending" | "sent" | "failed" | "ambiguous";
type AlertAttempt = {
  id: number;
  state_version: number;
  from_state_json: string;
  to_state_json: string;
  body: string;
  status: AlertAttemptStatus;
  attempts: number;
  next_attempt: number;
  error: string | null;
};

export type AlertOutcome = { down: string[]; recovered: string[]; posted: boolean };

function readStringSet(db: Database, key: string): Set<string> {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM app_state WHERE key=?").get(key);
  if (!row) return new Set();
  try {
    const value: unknown = JSON.parse(row.value);
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function readStateVersion(db: Database): number {
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM app_state WHERE key=?")
    .get(ALERT_STATE_VERSION_KEY);
  const value = Number(row?.value ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function writeAlertState(db: Database, active: Set<string>, version: number): void {
  const value = JSON.stringify([...active].sort());
  db.transaction(() => {
    writeAlertStateRows(db, value, version);
  })();
}

function writeAlertStateRows(db: Database, value: string, version: number): void {
  db.query("INSERT INTO app_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    ALERT_DOWN_KEY,
    value,
  );
  db.query("INSERT INTO app_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    ALERT_STATE_VERSION_KEY,
    String(version),
  );
}

function parseAlertState(value: string): Set<string> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? new Set(parsed) : null;
  } catch {
    return null;
  }
}

/** A process stopped while posting an alert: the outcome is unknown and must not be retried. */
export function recoverInterruptedAlerts(db: Database): void {
  const now = Date.now();
  const interrupted = db
    .query<{ state_version: number; to_state_json: string }, []>(
      "SELECT state_version,to_state_json FROM alert_attempts WHERE status='sending' ORDER BY state_version",
    )
    .all();
  if (!interrupted.length) return;
  db.transaction(() => {
    for (const attempt of interrupted) {
      db.query(
        "UPDATE alert_attempts SET status='ambiguous',error='Process stopped during alert send; verify the alert channel before retrying',updated_at=? WHERE status='sending' AND state_version=?",
      ).run(now, attempt.state_version);
      const active = parseAlertState(attempt.to_state_json);
      if (active) writeAlertStateRows(db, JSON.stringify([...active].sort()), attempt.state_version);
    }
  })();
}

function attemptForState(
  db: Database,
  version: number,
  fromState: string,
  toState: string,
  body: string,
  now: number,
): AlertAttempt {
  db.transaction(() => {
    db.query(
      `INSERT INTO alert_attempts(
         state_version,from_state_json,to_state_json,body,status,attempts,next_attempt,created_at,updated_at
       ) VALUES(?,?,?,?, 'pending',0,0,?,?)
       ON CONFLICT(state_version) DO NOTHING`,
    ).run(version, fromState, toState, body, now, now);
  })();
  const attempt = db
    .query<AlertAttempt, [number]>(
      "SELECT id,state_version,from_state_json,to_state_json,body,status,attempts,next_attempt,error FROM alert_attempts WHERE state_version=?",
    )
    .get(version);
  if (!attempt || attempt.from_state_json !== fromState || attempt.to_state_json !== toState)
    throw new Error(`Alert transition ${version} has inconsistent durable state`);
  return attempt;
}

function claimAlertAttempt(db: Database, id: number, now: number): AlertAttempt | null {
  return db
    .query<AlertAttempt, [number, number, number]>(
      `UPDATE alert_attempts
       SET status='sending',attempts=attempts+1,updated_at=?
       WHERE id=? AND status IN ('pending','failed') AND next_attempt<=?
       RETURNING id,state_version,from_state_json,to_state_json,body,status,attempts,next_attempt,error`,
    )
    .get(now, id, now);
}

function settleAlertAttempt(
  db: Database,
  attempt: AlertAttempt,
  status: Exclude<AlertAttemptStatus, "pending" | "sending">,
  error: string | null,
  active: Set<string>,
  version: number,
  now: number,
): void {
  db.transaction(() => {
    db.query("UPDATE alert_attempts SET status=?,error=?,next_attempt=0,updated_at=? WHERE id=?").run(
      status,
      error,
      now,
      attempt.id,
    );
    if (status === "sent" || status === "ambiguous") {
      const value = JSON.stringify([...active].sort());
      writeAlertStateRows(db, value, version);
    }
  })();
}

function retryAlertAttempt(db: Database, attempt: AlertAttempt, now: number): void {
  db.query("UPDATE alert_attempts SET status='failed',error=?,next_attempt=0,updated_at=? WHERE id=?").run(
    "Alert channel rejected the message",
    now,
    attempt.id,
  );
}

function alertLine(issue: ActionableIssue | undefined, id: string, recovered: boolean): string {
  if (!issue) return `${recovered ? "🟢" : "🔴"} **${id}** ${recovered ? "is reporting again" : "requires attention"}`;
  return recovered ? `🟢 **${id}** is reporting again` : `🔴 **${id}** — ${issue.message}`;
}

export async function publishAlerts(
  db: Database,
  config: AppConfig,
  request: Fetch = fetch,
  now = Date.now(),
): Promise<AlertOutcome> {
  const outcome: AlertOutcome = { down: [], recovered: [], posted: false };
  if (!config.alertChannelId || !config.DISCORD_BOT_TOKEN) return outcome;

  const issues = listActionableIssues(db, config, now).filter(
    (issue) => alertableKinds.has(issue.kind) && issue.severity !== "warning",
  );
  const previous = readStringSet(db, ALERT_DOWN_KEY);
  const version = readStateVersion(db);
  const strikes = readCounters(db, ALERT_STRIKES_KEY);
  const clearStrikes = readCounters(db, ALERT_CLEAR_KEY);
  const nextStrikes: Record<string, number> = {};
  for (const issue of issues) nextStrikes[issue.id] = (strikes[issue.id] ?? 0) + 1;
  const present = new Set(issues.map((issue) => issue.id));
  const nextClear: Record<string, number> = {};
  for (const id of previous) if (!present.has(id)) nextClear[id] = (clearStrikes[id] ?? 0) + 1;
  writeCounters(db, ALERT_STRIKES_KEY, nextStrikes);
  writeCounters(db, ALERT_CLEAR_KEY, nextClear);
  const current = new Set([
    ...issues.filter((issue) => (nextStrikes[issue.id] ?? 0) >= CONFIRMATIONS).map((issue) => issue.id),
    // A problem that was announced stays announced while it is still there, and for one more
    // reading after it disappears, so that a source flapping in and out speaks once.
    ...[...previous].filter((id) => present.has(id) || (nextClear[id] ?? 0) < CONFIRMATIONS),
  ]);
  outcome.down = [...current].filter((id) => !previous.has(id));
  outcome.recovered = [...previous].filter((id) => !current.has(id));

  if (!outcome.down.length && !outcome.recovered.length) return outcome;

  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  const sourceIssueIds = new Set(
    issues
      .filter((issue) => issue.kind === "source_failed" || issue.kind === "collection_degraded")
      .map((issue) => issue.id),
  );
  const lines =
    outcome.down.length >= PATH_OUTAGE && outcome.down.every((id) => sourceIssueIds.has(id))
      ? [
          `🔴 **${outcome.down.length} collectors stopped reporting at once** — this is one shared path, not ${outcome.down.length} broken sources.`,
          outcome.down.slice(0, 6).join(", ") + (outcome.down.length > 6 ? ", …" : ""),
          ...outcome.recovered.map((id) => alertLine(issueById.get(id), id, true)),
        ]
      : [
          ...outcome.down.map((id) => alertLine(issueById.get(id), id, false)),
          ...outcome.recovered.map((id) => alertLine(issueById.get(id), id, true)),
        ];
  const embed = {
    title: outcome.down.length ? "Signal Forge problem" : "Signal Forge recovered",
    description: lines.join("\n").slice(0, 4000),
    color: outcome.down.length ? 0xe74c3c : 0x2ecc71,
    footer: { text: alertFooter(current.size, issues.length - current.size) },
    timestamp: new Date(now).toISOString(),
  };
  const fromState = JSON.stringify([...previous].sort());
  const toState = JSON.stringify([...current].sort());
  const attempt = attemptForState(
    db,
    version + 1,
    fromState,
    toState,
    JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
    now,
  );

  if (attempt.status === "sent" || attempt.status === "ambiguous") {
    writeAlertState(db, current, version + 1);
    outcome.posted = attempt.status === "sent";
    return outcome;
  }
  const claimed = claimAlertAttempt(db, attempt.id, now);
  if (!claimed) return outcome;

  try {
    const response = await measure(db, "alerts.send", () =>
      request(`https://discord.com/api/v10/channels/${config.alertChannelId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bot ${config.DISCORD_BOT_TOKEN}` },
        body: claimed.body,
        signal: AbortSignal.timeout(20_000),
        redirect: "error",
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      retryAlertAttempt(db, claimed, now);
      log("warn", "Alert rejected", { status: response.status });
      return outcome;
    }
    const parsed = alertResponse.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      settleAlertAttempt(
        db,
        claimed,
        "ambiguous",
        "Alert response was not confirmable; verify the channel before retrying",
        current,
        version + 1,
        now,
      );
      log("warn", "Alert outcome unknown", { reason: "invalid provider response" });
      return outcome;
    }
    settleAlertAttempt(db, claimed, "sent", null, current, version + 1, now);
    outcome.posted = true;
    return outcome;
  } catch {
    settleAlertAttempt(
      db,
      claimed,
      "ambiguous",
      "Alert outcome unknown; verify the channel before retrying",
      current,
      version + 1,
      now,
    );
    log("warn", "Alert outcome unknown", { reason: "network failure" });
    return outcome;
  }
}
