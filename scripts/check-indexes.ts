/**
 * Every declared index has to be explainable, and the explanation has to be in the repository.
 *
 * "A new index ships with the read it was for, in src/storage/hotQueries.ts, and with `ANALYZE;` in
 * the same migration" has been a rule in AGENTS.md since migration 049 shipped five indexes the
 * planner ignored. It was held by whoever read the diff, and the first time anything counted --
 * `index-cost`, two commits ago -- the answer was 25 declared indexes that no hot read named, 16.9
 * MB of them. One of those turned out to be the largest index in the database, 14.1 MB, duplicating
 * a key its table could have been; migration 076 deleted it. A rule nothing checks is a rule that
 * has already been broken for a year.
 *
 * What this does not do is guess. `indexReaders.ts` derives four kinds of use from the schema --
 * a hot read's plan, a hot write's plan, a UNIQUE constraint, a foreign key's referential action --
 * and anything left over has to have a line in RECORD saying what reads it. The derived kinds are
 * the point: the first version of this was going to carry a hand-written exemption for
 * `model_fact_fields_event` with a guess attached, and `pragma_foreign_key_list` knows that
 * `ON DELETE SET NULL` is what reads that column when retention deletes an event.
 *
 * RECORD is closed, the way check-size's BUDGET is. It is what was unexplained on the day this was
 * written, each with the reader it has, and the way out for a new index is the hot statement it was
 * for -- which is already the rule. It is checked in both directions: a line for an index that no
 * longer exists fails, and so does an index that has since gained a hot statement, because a record
 * that is never pruned stops being a record of anything.
 *
 * Runs against a schema built from the migrations in memory, so it needs nothing but the repository
 * and works on the Linux runner. It cannot say what an index costs -- that is `dbstat`, which no
 * Linux Bun has, and that half stays in `bun run index-cost` against a copy.
 */
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/storage/migrationRunner.js";
import { indexUses, unexplained } from "./indexReaders.js";

/**
 * What was unexplained when this check was written, and what actually reads each one.
 *
 * Read it as a list of work: every line here is a statement that could be in `HOT_QUERIES` and is
 * not, which means its plan is unchecked and a migration could quietly take its index away. The
 * pattern is visible in the list -- most of these are a queue polled by due time or a sweep by
 * timestamp, neither of which anyone thought of as a hot read.
 */
const RECORD: Readonly<Record<string, string>> = {
  alert_attempts_due: "the alert queue, polled by (status, next_attempt_at) on every publish cycle -- src/alerts.ts",
  deliveries_pending: "the delivery queue, the same shape and the same cycle -- deliverPending in src/delivery.ts",
  lifecycle_reminders_due: "reminders that have come due, joined against their deadline -- src/lifecycle.ts:319",
  lifecycle_deadlines_time: "deadlines inside a window, ordered by when -- src/lifecycle.ts:278",
  model_facts_key:
    "a model looked up by canonical_key, which is how every fact write finds its row -- src/modelFacts.ts",
  event_evaluations_evaluated: "whether anything has been judged since an instant -- src/events/standing.ts:93",
  deepseek_usage_operation: "spend by operation over a window, which the budget report reads",
  deepseek_usage_attempted_at:
    "spend over a window regardless of operation, and the retention sweep over the same column",
  operator_journal_recorded_at:
    "the journal newest-first, and retention deleting the tail of it -- src/storage/retention.ts:341",
  suppressions_recorded_at: "what was suppressed recently, grouped by reason -- src/boards/suppressions.ts:22",
  snapshots_collected: "the retention sweeps, which find bodies to expire by age",
  publications_date: "a publication by its date, which is how a recap knows what it already said",
  stories_released: "stories released in a window",
  stories_updated: "stories touched since an instant, which is what the incremental projection reads",
  hypotheses_updated: "the same, for hypotheses",
  model_facts_updated: "the same, for model facts",
};

const db = new Database(":memory:");
// ON, because a foreign key with no enforcement needs no index to enforce it, and the whole point
// of deriving that kind of use is that production runs with it on. See src/storage/database.ts.
db.exec("PRAGMA foreign_keys=ON");
runMigrations(db);
// Without it the planner has no statistics and reaches for fewer indexes than production does, so
// a hot read that does name its index here would be reported as naming nothing. 049 again.
db.exec("ANALYZE");

const uses = indexUses(db);
const unaccounted = unexplained(uses);
db.close();

const problems: string[] = [];
for (const use of unaccounted)
  if (!(use.index in RECORD))
    problems.push(
      `${use.index} on ${use.table}(${use.columns.join(", ")}) is declared by a migration and nothing explains it.\n` +
        "  No hot read or write names it, it enforces no UNIQUE, and it backs no foreign key.\n" +
        "  Add the statement it exists for to src/storage/hotQueries.ts -- which is the rule a new index already ships under.\n" +
        "  RECORD in this file is closed: it records what was unexplained when the check was built, and a new line in it is the ratchet turning the wrong way.",
    );
for (const index of Object.keys(RECORD)) {
  const use = uses.find((one) => one.index === index);
  if (!use) problems.push(`RECORD names ${index}, which the schema no longer has. Remove the line.`);
  else if (!unaccounted.includes(use))
    problems.push(
      `RECORD names ${index}, which is now explained by ${use.hotStatements.length ? `a hot statement (${use.hotStatements[0]})` : use.unique ? "its UNIQUE constraint" : `a foreign key (${use.foreignKey ?? "?"})`}. Remove the line.`,
    );
}

if (problems.length) {
  process.stderr.write(`${problems.join("\n\n")}\n`);
  process.exit(1);
}

const derived = uses.filter((use) => use.declared && !unaccounted.includes(use));
process.stdout.write(
  `Index accounting passed: ${uses.length} indexes, ${derived.length} explained by the schema ` +
    `(${derived.filter((use) => use.hotStatements.length).length} by a hot statement, ` +
    `${derived.filter((use) => !use.hotStatements.length && use.unique).length} by a UNIQUE, ` +
    `${derived.filter((use) => !use.hotStatements.length && !use.unique && use.foreignKey).length} by a foreign key), ` +
    `${unaccounted.length} recorded.\n`,
);
