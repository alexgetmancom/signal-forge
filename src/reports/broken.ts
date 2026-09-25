import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config.js";
import { type FlakySource, flakySources } from "./flakySources.js";
import { type ActionableIssue, listActionableIssues } from "./issues.js";
import { type Outage, outages } from "./outages.js";
import { type SilentSource, silentSources } from "./silentSources.js";

/**
 * Four kinds of broken, asked once.
 *
 * `issues`, `silent-sources`, `flaky` and `outages` read four different things and each is blind to
 * the other three: the present, an absence, a rate, and a correlation. A source failing two
 * attempts in three and succeeding on the third is never silent and only red if the minute you look
 * happens to be a failing one -- `arena` sat at 73% for three days carrying the codenames and none
 * of the first three said so on its own. That is a real property of the data, and until now it was
 * carried in two paragraphs of AGENTS.md telling an operator to run three commands and remember
 * which was which. An instruction that has to be remembered is a report that was not written.
 *
 * Nothing new is measured here. Each section names the reading it is, which is the part that was
 * prose, and `readings` is the one new fact: a source flagged by more than one of them is a
 * different problem from a source flagged by one, and neither command could see the other.
 */
export type BrokenReport = {
  days: number;
  /** One sentence, so a session can open on a single line rather than on four lists. */
  headline: string;
  /** Every source any reading flagged, and which ones did. Two readings on one source is a signal. */
  readings: { source: string; readings: ("now" | "silent" | "flaky" | "outage")[] }[];
  now: { reading: string; issues: ActionableIssue[] };
  silent: { reading: string; sources: SilentSource[] };
  flaky: { reading: string; sources: FlakySource[] };
  outages: { reading: string; groups: Outage[] };
};

/** The slowest list to read is the rate; past this many rows nobody reads it at all. */
const FLAKY_SHOWN = 10;

function countPhrase(count: number, one: string, many: string): string | null {
  return count ? `${count} ${count === 1 ? one : many}` : null;
}

export function brokenReport(db: Database, config: AppConfig, days = 3, now = Date.now()): BrokenReport {
  const issues = listActionableIssues(db, config, now);
  const silent = silentSources(db, config, days, new Date(now));
  const flaky = flakySources(db, config, days, now);
  // A correlated outage is read over a longer window than a rate: one host falling over twice in a
  // week is the finding, and three days can hold one of those two and call it a coincidence.
  //
  // Only the groups that actually failed together. `outages` lists every group that failed at all,
  // which is right for reading a grouping; here it is a finding, and a group with no concurrent
  // minute is not one. Measured on production the first time this ran: eleven groups, of which
  // four had failed together and `Arena` led the rest with 242 failures and no correlation at all.
  // Counting all eleven made the headline say "11 hosts failing as one", and flagged `claude-web`
  // as part of an outage because something else on the Web group had failed that week.
  const groups = outages(db, config, Math.max(days, 7), now).filter((group) => group.concurrentMinutes > 0);

  const readings = new Map<string, ("now" | "silent" | "flaky" | "outage")[]>();
  const flag = (source: string, reading: "now" | "silent" | "flaky" | "outage") => {
    const already = readings.get(source) ?? [];
    if (!already.includes(reading)) readings.set(source, [...already, reading]);
  };
  for (const issue of issues) if (issue.source) flag(issue.source, "now");
  for (const source of silent) flag(source.source, "silent");
  for (const source of flaky) flag(source.id, "flaky");
  // Membership is not participation. A pacing group is a host, so every source pointed at that host
  // is in it whether or not it was failing when the host fell over: 30 of the 44 sources this report
  // listed on 2026-09-25 carried `outage` and nothing else, and `anthropic-sdk-releases` was flagged
  // as part of an outage without having failed once in the window. That buries the finding the
  // readings exist for -- a source two of them agree on -- under a list of everything sharing a
  // host with something that broke. Only the sources that failed inside one of the shared minutes.
  for (const group of groups) for (const member of group.members) if (member.concurrent > 0) flag(member.id, "outage");

  const headline =
    [
      countPhrase(issues.length, "problem now", "problems now"),
      countPhrase(
        silent.filter((source) => source.state === "never_polled").length,
        "source never polled",
        "sources never polled",
      ),
      countPhrase(
        silent.filter((source) => source.state === "never_succeeded").length,
        "source that has never collected",
        "sources that have never collected",
      ),
      countPhrase(
        silent.filter((source) => source.state === "went_quiet").length,
        "source gone quiet",
        "sources gone quiet",
      ),
      countPhrase(flaky.length, "source losing collections", "sources losing collections"),
      countPhrase(groups.length, "host failing as one", "hosts failing as one"),
    ]
      .filter(Boolean)
      .join(", ") || "Nothing is broken by any of the four readings";

  return {
    days,
    headline,
    readings: [...readings.entries()]
      .map(([source, found]) => ({ source, readings: found }))
      .sort((left, right) => right.readings.length - left.readings.length || left.source.localeCompare(right.source)),
    now: { reading: "the present: what is red at this moment, sources and everything else", issues },
    silent: {
      reading: "an absence: enabled sources that have collected nothing lately, and those never asked at all",
      sources: silent,
    },
    flaky: {
      reading: "a rate: sources that fail often but not always, by faultRate rather than failureRate",
      sources: flaky.slice(0, FLAKY_SHOWN),
    },
    outages: { reading: "a correlation: sources of one host that failed inside the same minute", groups },
  };
}
