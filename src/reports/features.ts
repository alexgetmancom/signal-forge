import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config.js";
import { FEATURE_IDS, type FeatureId, type FeatureState, featureStates } from "../features.js";

/**
 * What this deployment is doing, and when each of those things last did anything.
 *
 * The state alone answers half the question. A feature that is on and has spoken once in six weeks
 * is the revision list, and a feature that is on and has never spoken is either broken or was never
 * reachable -- both of which read as "on" and neither of which is. So each entry carries the last
 * time it left a trace in the database, taken from the trace itself rather than from the worker that
 * runs it: a worker's heartbeat says the cycle ran, which is exactly the thing that is not in doubt.
 *
 * Where nothing in the database belongs to one feature alone, `lastActivity` is null and says so in
 * `activity`. An invented timestamp would be worse than none: it would be read.
 */
type FeatureStanding = FeatureState & {
  /** The trace read for `lastActivity`, or why there is no trace to read. */
  activity: string;
  lastActivity: string | null;
  quietDays: number | null;
};

export type FeatureReport = {
  features: FeatureStanding[];
  /**
   * Keys in `featureEnabled` that name no feature. The same trap a misspelled credential used to
   * be: the switch is accepted, does nothing, and the feature keeps running.
   */
  unknown: string[];
};

type Trace = { activity: string; read: (db: Database) => string | null };

const recapTrace = (source: string): Trace => ({
  activity: `the last ${source} batch`,
  read: (db) =>
    db
      .query<{ at: string | null }, [string]>(
        "SELECT MAX(ready_at) AS at FROM batches WHERE kind='weekly_recap' AND source=?",
      )
      .get(source)?.at ?? null,
});

const millisecondsTrace = (activity: string, sql: string): Trace => ({
  activity,
  read: (db) => {
    const at = db.query<{ at: number | null }, []>(sql).get()?.at ?? null;
    return at === null ? null : new Date(at).toISOString();
  },
});

const instantTrace = (activity: string, sql: string): Trace => ({
  activity,
  read: (db) => db.query<{ at: string | null }, []>(sql).get()?.at ?? null,
});

const noTrace = (activity: string): Trace => ({ activity, read: () => null });

/**
 * One trace per feature. A detector writes an ordinary event batch under the source that produced
 * the evidence, so nothing in the database distinguishes a breakout card from any other card; that
 * is a gap in what is stored, and it is named here rather than papered over.
 */
const TRACES: Record<FeatureId, Trace> = {
  "weekly-recap": recapTrace("weekly-recap"),
  "daily-recap": recapTrace("daily-recap"),
  "daily-news": recapTrace("daily-news"),
  "lifecycle-reminders": instantTrace(
    "the last lifecycle reminder batch",
    "SELECT MAX(ready_at) AS at FROM batches WHERE kind='lifecycle_reminder'",
  ),
  breakouts: noTrace("nothing: a breakout is delivered as an ordinary card under the board's own source"),
  corroboration: noTrace("nothing: a corroborated event is delivered as an ordinary card under its own source"),
  promotion: instantTrace("the last promotion batch", "SELECT MAX(ready_at) AS at FROM batches WHERE kind='promotion'"),
  "telegram-reactions": noTrace("nothing: telegram_reactions keeps a count per message and no time it was read"),
  "status-boards": noTrace("nothing: a board is edited in place and its state is keyed, not dated"),
  "operational-alerts": millisecondsTrace(
    "the last operational alert attempt",
    "SELECT MAX(created_at) AS at FROM alert_attempts",
  ),
  "review-posts": noTrace("nothing: a review marks its own period as sent in app_state, without a date of its own"),
  "jev-verdicts": instantTrace(
    "the last judgement Jev returned",
    "SELECT MAX(evaluated_at) AS at FROM event_evaluations WHERE evaluator='jev'",
  ),
  "deepseek-summaries": instantTrace("the last written lead", "SELECT MAX(created_at) AS at FROM summaries"),
  "publications-sync": instantTrace("the last publication checked", "SELECT MAX(checked_at) AS at FROM publications"),
};

export function featureReport(db: Database, config: AppConfig, now = new Date()): FeatureReport {
  const known = new Set<string>(FEATURE_IDS);
  return {
    features: featureStates(config).map((state) => {
      const trace = TRACES[state.id];
      const lastActivity = trace.read(db);
      return {
        ...state,
        activity: trace.activity,
        lastActivity,
        quietDays: lastActivity === null ? null : Math.floor((now.getTime() - Date.parse(lastActivity)) / 86_400_000),
      };
    }),
    unknown: Object.keys(config.featureEnabled ?? {})
      .filter((key) => !known.has(key))
      .sort(),
  };
}
