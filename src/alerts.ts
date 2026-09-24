import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { Fetch } from "./http-client.js";
import { log } from "./logger.js";
import { type ActionableIssue, type IssueKind, listActionableIssues } from "./reports/issues.js";
import { measure } from "./runtime/metrics.js";
import { readState, writeState } from "./storage/appState.js";
import { clip } from "./text.js";

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
/**
 * How many times a problem has come back after being announced as gone.
 *
 * Two confirmations each way stop one blip; they do nothing about a source that is genuinely up and
 * down all day, because it clears the same low bar every time. Hugging Face was announced broken 46
 * times and recovered 45, artificial-analysis 15 and 15, Anthropic 15: of 345 alerts ever sent, most
 * are four sources saying the same two things at each other. The first failure still speaks after
 * two readings -- what a flapper has to buy is the right to interrupt again, one more confirmation
 * per flap, so a chronic one announces itself about once an hour instead of every five minutes.
 */
const ALERT_FLAPS_KEY = "alert_flaps";
/** However badly something flaps, an hour of one state is enough to be believed. */
const MAX_CONFIRMATIONS = 12;

function readCounters(db: Database, key: string): Record<string, number> {
  const stored = readState(db, key);
  try {
    const parsed: unknown = stored ? JSON.parse(stored) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeCounters(db: Database, key: string, counters: Record<string, number>): void {
  const value = JSON.stringify(counters);
  writeState(db, key, value);
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
/**
 * What is worth interrupting the owner for.
 *
 * A delivery that failed for good was not on this list, and that is how a 403 on the public
 * channel stayed undiscovered for a day: nothing retries a failed delivery, the board that would
 * have shown it is passive, and the feed being silent looks exactly like a quiet week. A send that
 * will never happen on its own is precisely the case the alert channel exists for.
 */
const alertableKinds = new Set<IssueKind>([
  "source_failed",
  "collection_degraded",
  "worker_failed",
  "worker_stale",
  "delivery_stuck",
  "delivery_failed",
  "delivery_blocked",
  "delivery_ambiguous",
  "board_stalled",
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
  next_attempt_at: string;
  error: string | null;
};

/** The alert clock is stored as an instant, like every other instant in this database. */
const instant = (epochMs: number): string => new Date(epochMs).toISOString();

export type AlertOutcome = { down: string[]; recovered: string[]; posted: boolean };

function readStringSet(db: Database, key: string): Set<string> {
  const stored = readState(db, key);
  if (!stored) return new Set();
  try {
    const value: unknown = JSON.parse(stored);
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function readStateVersion(db: Database): number {
  const value = Number(readState(db, ALERT_STATE_VERSION_KEY) ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function writeAlertState(db: Database, active: Set<string>, version: number): void {
  const value = JSON.stringify([...active].sort());
  db.transaction(() => {
    writeAlertStateRows(db, value, version);
  })();
}

function writeAlertStateRows(db: Database, value: string, version: number): void {
  writeState(db, ALERT_DOWN_KEY, value);
  writeState(db, ALERT_STATE_VERSION_KEY, String(version));
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
      ).run(instant(now), attempt.state_version);
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
         state_version,from_state_json,to_state_json,body,status,attempts,created_at,updated_at
       ) VALUES(?,?,?,?, 'pending',0,?,?)
       ON CONFLICT(state_version) DO NOTHING`,
    ).run(version, fromState, toState, body, instant(now), instant(now));
    // An attempt nobody received describes a transition that no longer exists once the problems
    // move on. It is rewritten to the one that does, rather than wedging every later cycle on the
    // mismatch. A sent or ambiguous attempt is history and is never rewritten.
    db.query(
      `UPDATE alert_attempts SET from_state_json=?,to_state_json=?,body=?,updated_at=?
       WHERE state_version=? AND status IN ('pending','failed') AND (from_state_json<>? OR to_state_json<>?)`,
    ).run(fromState, toState, body, instant(now), version, fromState, toState);
  })();
  const attempt = db
    .query<AlertAttempt, [number]>(
      "SELECT id,state_version,from_state_json,to_state_json,body,status,attempts,next_attempt_at,error FROM alert_attempts WHERE state_version=?",
    )
    .get(version);
  if (!attempt || attempt.from_state_json !== fromState || attempt.to_state_json !== toState)
    throw new Error(`Alert transition ${version} has inconsistent durable state`);
  return attempt;
}

function claimAlertAttempt(db: Database, id: number, now: number): AlertAttempt | null {
  return db
    .query<AlertAttempt, [string, number, string]>(
      `UPDATE alert_attempts
       SET status='sending',attempts=attempts+1,updated_at=?
       WHERE id=? AND status IN ('pending','failed') AND next_attempt_at<=?
       RETURNING id,state_version,from_state_json,to_state_json,body,status,attempts,next_attempt_at,error`,
    )
    .get(instant(now), id, instant(now));
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
    db.query(
      "UPDATE alert_attempts SET status=?,error=?,next_attempt_at='1970-01-01T00:00:00.000Z',updated_at=? WHERE id=?",
    ).run(status, error, instant(now), attempt.id);
    if (status === "sent" || status === "ambiguous") {
      const value = JSON.stringify([...active].sort());
      writeAlertStateRows(db, value, version);
    }
  })();
}

function retryAlertAttempt(db: Database, attempt: AlertAttempt, now: number): void {
  db.query(
    "UPDATE alert_attempts SET status='failed',error=?,next_attempt_at='1970-01-01T00:00:00.000Z',updated_at=? WHERE id=?",
  ).run("Alert channel rejected the message", instant(now), attempt.id);
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
  const flaps = readCounters(db, ALERT_FLAPS_KEY);
  const confirmations = (id: string) => Math.min(CONFIRMATIONS + (flaps[id] ?? 0), MAX_CONFIRMATIONS);
  const current = new Set([
    ...issues.filter((issue) => (nextStrikes[issue.id] ?? 0) >= confirmations(issue.id)).map((issue) => issue.id),
    // A problem that was announced stays announced while it is still there, and for one more
    // reading after it disappears, so that a source flapping in and out speaks once.
    // Recovery is not charged: what a flapper buys is the right to interrupt, and a problem that
    // has genuinely gone should stop being shown as soon as it is believed.
    ...[...previous].filter((id) => present.has(id) || (nextClear[id] ?? 0) < CONFIRMATIONS),
  ]);
  outcome.down = [...current].filter((id) => !previous.has(id));
  outcome.recovered = [...previous].filter((id) => !current.has(id));
  // Every announcement is counted, so the next one from the same problem costs one more reading.
  // Counted on the way down, where the interruption is; the count is what a flapper is charged and
  // what a source that broke once and was fixed never pays again.
  if (outcome.down.length) {
    const nextFlaps = { ...flaps };
    for (const id of outcome.down) nextFlaps[id] = Math.min((flaps[id] ?? 0) + 1, MAX_CONFIRMATIONS);
    writeCounters(db, ALERT_FLAPS_KEY, nextFlaps);
  }

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
    description: clip(lines.join("\n"), 4000),
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
