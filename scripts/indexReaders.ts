/**
 * Which statement each index exists for, worked out from the schema rather than remembered.
 *
 * "A new index ships with the read it was for, in src/storage/hotQueries.ts" is a rule in
 * AGENTS.md, and until this it was enforced by whoever happened to read the diff. 25 declared
 * indexes had no hot read naming them when `index-cost` first printed the list, which is what a
 * rule held by attention looks like after a year.
 *
 * Four kinds of reader, and all four had to exist before the rule could be checked at all:
 *
 *  - a hot read names it in its plan. This is the one the rule was written about.
 *  - a hot write names it in its plan. `source_collection_metrics_source_time` was the largest
 *    index in the database and no read reached for it, because its only caller was an
 *    `INSERT ... SELECT`. An index can be load-bearing for a statement that returns nothing.
 *  - it is UNIQUE, which makes it a constraint rather than a cost. See `unique` below.
 *  - a foreign key's ON DELETE or ON UPDATE action needs it. SQLite enforces those by looking up
 *    the child rows of a deleted parent, which is a query nothing in this repository writes and
 *    which no plan here will ever mention. `model_fact_fields_event` is one: the only thing that
 *    reads `model_fact_fields` by `event_id` is `ON DELETE SET NULL` firing when retention deletes
 *    an event, and `PRAGMA foreign_keys` is ON in production.
 *
 * The third is why this is derived and not a list. An exemption line would have been written for
 * `model_fact_fields_event` with a guess for a reason; `pragma_foreign_key_list` knows.
 */
import type { Database } from "bun:sqlite";
import { HOT_QUERIES, HOT_WRITES } from "../src/storage/hotQueries.js";

export type IndexUse = {
  index: string;
  table: string;
  /** False for an autoindex, which SQLite made for a UNIQUE or non-INTEGER PRIMARY KEY. */
  declared: boolean;
  columns: string[];
  /** Hot statements whose plan names it, reads and writes alike. */
  hotStatements: string[];
  /** The foreign key whose referential action needs it, as `table.column -> parent`, or null. */
  foreignKey: string | null;
  /**
   * Whether it enforces uniqueness, in which case it is a constraint wearing an index's clothes.
   *
   * Asking which read a UNIQUE index exists for is the wrong question: it exists so that a second
   * row cannot be written, and dropping it changes what the database accepts rather than what it
   * costs. `batches_recap_period` is one -- `UNIQUE(source, ready_at) WHERE kind='weekly_recap'`
   * is how one recap per source per week is guaranteed, and no read has to name it for that to be
   * load-bearing.
   */
  unique: boolean;
  /**
   * The text of its WHERE clause, or null for an index over every row.
   *
   * Kept because it is the one thing that makes a narrower index legitimate beside a wider one:
   * `source_collection_metrics_failures` is `(source, collected_at) WHERE success = 0`, and the
   * 14.1 MB index over the same two columns for every row was not its duplicate so much as its
   * superset. Parsed from the text rather than from a pragma, because SQLite exposes partiality
   * nowhere else, and it is only ever reported to a human.
   */
  partial: string | null;
};

/** Two indexes on one table where one's columns lead the other's, and one of them is probably paying for the other. */
export type RedundantPair = {
  table: string;
  /** The one whose columns are the leading prefix. Not necessarily the one worth dropping. */
  prefix: IndexUse;
  /** The one that extends it. */
  covering: IndexUse;
};

/** Every statement whose plan is evidence that an index is used. `EXPLAIN` runs a write without doing it. */
const PLANNED: readonly { name: string; sql: string; params: readonly (string | number | null)[] }[] = [
  ...HOT_QUERIES.map((query) => ({ name: query.name, sql: query.sql, params: query.params })),
  ...HOT_WRITES.map((write) => ({ name: `write: ${write.name}`, sql: write.sql, params: write.params })),
];

/**
 * The plan line is the only honest source. An index can be declared over exactly the columns a
 * statement filters on and still be ignored, which is what `ANALYZE` decides -- migration 049
 * shipped five of those. `USING INTEGER PRIMARY KEY` is not an index and is not counted; a
 * WITHOUT ROWID table's key appears under the table's own name, which is why a statement reading
 * one shows up against no index at all.
 */
export function hotStatementsByIndex(db: Database): Map<string, string[]> {
  const named = new Map<string, string[]>();
  for (const statement of PLANNED) {
    let plan = "";
    try {
      const prepared = db.prepare<{ detail: string }, (string | number | null)[]>(
        `EXPLAIN QUERY PLAN ${statement.sql}`,
      );
      plan = prepared
        .all(...statement.params)
        .map((row) => row.detail)
        .join(" | ");
      prepared.finalize();
    } catch {
      // A statement naming something this database does not have says nothing either way.
      continue;
    }
    for (const match of plan.matchAll(/USING (?:COVERING )?INDEX ([A-Za-z_][\w]*)/g)) {
      const name = match[1] as string;
      if (!named.has(name)) named.set(name, []);
      const already = named.get(name) as string[];
      // Once per statement, not once per mention. "drop the snapshots nothing points at" is two
      // DELETE ... NOT IN subqueries, so its plan names `events_snapshot` twice and the index was
      // listed with the same reader twice -- which reads as two callers where there is one.
      if (!already.includes(statement.name)) already.push(statement.name);
    }
  }
  return named;
}

/**
 * Which index each foreign key with a referential action would use, by leading column.
 *
 * By leading column and not by exact match, because that is how SQLite picks one: a child index
 * whose first column is the foreign key's column serves the lookup. `NO ACTION` and `RESTRICT`
 * need the same lookup to decide whether to refuse, so every kind counts except a key with no
 * action at all -- which SQLite reports as `NO ACTION`, so in practice every key counts.
 */
export function foreignKeysByIndex(
  db: Database,
  indexes: readonly { index: string; table: string; columns: string[] }[],
): Map<string, string> {
  const backing = new Map<string, string>();
  const tables = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all();
  for (const table of tables)
    for (const key of db
      .query<{ from: string; table: string; to: string | null }, []>(
        `SELECT "from", "table", "to" FROM pragma_foreign_key_list('${table.name}')`,
      )
      .all())
      for (const index of indexes)
        if (index.table === table.name && index.columns[0] === key.from && !backing.has(index.index))
          backing.set(index.index, `${table.name}.${key.from} -> ${key.table}(${key.to ?? "rowid"})`);
  return backing;
}

/** Every index in the schema with whatever uses it, largest-first ordering left to the caller. */
export function indexUses(db: Database): IndexUse[] {
  const statements = hotStatementsByIndex(db);
  const declared = db
    .query<{ name: string; tbl_name: string; sql: string | null }, []>(
      "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' ORDER BY name",
    )
    .all()
    .map((index) => ({
      index: index.name,
      table: index.tbl_name,
      declared: index.sql !== null,
      // An autoindex has no `sql` and is always a constraint: SQLite only makes one for a UNIQUE
      // or for a non-INTEGER PRIMARY KEY, so it exists to refuse a second row by definition.
      unique: index.sql === null || /\bCREATE\s+UNIQUE\s+INDEX\b/i.test(index.sql),
      partial: index.sql && /\sWHERE\s/i.test(index.sql) ? (index.sql.split(/\sWHERE\s/i)[1] as string).trim() : null,
      columns: db
        .query<{ name: string | null }, [string]>("SELECT name FROM pragma_index_info(?)")
        .all(index.name)
        .map((column) => column.name ?? "<expression>"),
    }));
  const foreignKeys = foreignKeysByIndex(db, declared);
  return declared.map((index) => ({
    ...index,
    hotStatements: statements.get(index.index) ?? [],
    foreignKey: foreignKeys.get(index.index) ?? null,
  }));
}

/** An index nothing in the schema can explain: declared by a migration, named by nothing, backing nothing. */
export function unexplained<Use extends IndexUse>(uses: readonly Use[]): Use[] {
  return uses.filter((use) => use.declared && !use.unique && use.hotStatements.length === 0 && use.foreignKey === null);
}

/**
 * Pairs where one index's columns are the leading prefix of another's, on the same table.
 *
 * An index on `(a)` beside an index on `(a, b)` is paid for on every write of the table and
 * answers nothing the wider one could not, because SQLite seeks a b-tree by its leading columns.
 * This session found two by hand -- `source_collection_metrics_source_time` against `_failures`
 * on the same two columns, 14.1 MB of it, and `snapshots_collected` against `snapshots_unexpired`
 * on the same one -- and both had the same cause: a migration added the more precise index and
 * left the one it displaced behind. Neither was noticed until something counted.
 *
 * What this reports is the pair, not the victim, and that is deliberate. Which of the two is worth
 * dropping is a question about bytes and about rows: the wider index is the bigger one, but the
 * narrower one is often partial, and a partial index cannot answer a query outside its WHERE. For
 * the 14.1 MB pair the right move was neither drop but a `WITHOUT ROWID` table, where the key
 * became the index. A check that named a victim would have named the wrong one.
 *
 * A UNIQUE prefix is never the suspect: `UNIQUE(a)` beside `UNIQUE(a, b)` is a strictly stronger
 * constraint, not a duplicate, and dropping it changes what the database accepts.
 */
export function redundantPrefixes(uses: readonly IndexUse[]): RedundantPair[] {
  const leads = (shorter: readonly string[], longer: readonly string[]): boolean =>
    shorter.length <= longer.length && shorter.every((column, at) => column === longer[at]);
  const pairs: RedundantPair[] = [];
  for (const one of uses)
    for (const other of uses) {
      if (one.index >= other.index || one.table !== other.table) continue;
      // Equal columns lead each other, so both orientations are candidates and the suspect is
      // whichever of them is not a UNIQUE constraint. With unequal columns only one can lead.
      const suspect = [
        { prefix: one, covering: other },
        { prefix: other, covering: one },
      ].find(({ prefix, covering }) => leads(prefix.columns, covering.columns) && !prefix.unique);
      if (suspect) pairs.push({ table: one.table, ...suspect });
    }
  return pairs;
}
