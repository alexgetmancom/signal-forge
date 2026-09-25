import type { Database } from "bun:sqlite";

/**
 * Who points at a table, what happens to them when a row goes, and what has to go first.
 *
 * Thirteen foreign keys point at `events`, which is the reason nobody has written the retention
 * that would delete one. The fear is usually described as the thirteen keys; it is not. Six of them
 * are `ON DELETE CASCADE` and take care of themselves, two are `SET NULL`, and the remaining five
 * are `NO ACTION`, which means the delete is refused -- and the refusal is the useful fact. A
 * hand-written list of what to clear first is a document that goes stale the next migration; this
 * reads the graph out of the database that is actually running.
 *
 * `orphans` is the other half. Foreign keys were not always enforced, so a child row whose parent
 * is gone can exist, and until something counts them nobody knows whether the constraint currently
 * describes the data or only the intention.
 */
export type TableReferences = {
  table: string;
  rows: number;
  referencedBy: {
    table: string;
    column: string;
    onDelete: string;
    rows: number;
    /** Rows of this table that actually name a parent. A nullable column is mostly not the problem. */
    referencing: number;
    /** Rows naming a parent that is not there. Anything but zero is a constraint nobody enforced. */
    orphans: number;
  }[];
  /** The references that make a delete fail. These are the work, and there is nothing else. */
  refuses: string[];
  /** The references that clean up after themselves. */
  cascades: string[];
  /** The references that keep the row and forget which parent it had. */
  clears: string[];
  /**
   * What a delete has to touch, in order, with the table itself last. Read out of the graph, so a
   * migration that adds a key changes this line rather than leaving a plan somewhere that is wrong.
   */
  deletionOrder: string[];
};

type ForeignKey = { table: string; from: string; to: string; on_delete: string };
/** One reference, as the database describes it: who points at the parent, with which column, how. */
type Child = { table: string; column: string; parentColumn: string; onDelete: string };

function tables(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
}

/** Every child pointing at each parent, as the running database describes itself. */
function graph(db: Database): Map<string, Child[]> {
  const byParent = new Map<string, Child[]>();
  for (const child of tables(db))
    for (const key of db.query<ForeignKey, []>(`PRAGMA foreign_key_list(${child})`).all()) {
      const entry = { table: child, column: key.from, parentColumn: key.to, onDelete: key.on_delete.toUpperCase() };
      byParent.set(key.table, [...(byParent.get(key.table) ?? []), entry]);
    }
  return byParent;
}

/**
 * The tables a delete has to reach, children before parents.
 *
 * Only a reference that refuses forces work: a cascade takes its own children with it. Walked
 * transitively, because a table that refuses may itself be refused by another.
 */
function order(byParent: Map<string, Child[]>, root: string): string[] {
  const placed: string[] = [];
  const seen = new Set<string>();
  const visit = (table: string): void => {
    if (seen.has(table)) return;
    seen.add(table);
    for (const child of byParent.get(table) ?? [])
      if (child.onDelete === "NO ACTION" || child.onDelete === "RESTRICT") visit(child.table);
    placed.push(table);
  };
  visit(root);
  return placed;
}

export function tableReferences(db: Database, table: string): TableReferences {
  if (!tables(db).includes(table)) throw new Error(`No table named ${table}`);
  const byParent = graph(db);
  const children = byParent.get(table) ?? [];
  const referencedBy = children.map((child) => {
    const rows = db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${child.table}`).get()?.count ?? 0;
    const referencing =
      db
        .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${child.table} WHERE ${child.column} IS NOT NULL`)
        .get()?.count ?? 0;
    const orphans =
      db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM ${child.table} c
            WHERE c.${child.column} IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM ${table} p WHERE p.${child.parentColumn} = c.${child.column})`,
        )
        .get()?.count ?? 0;
    const { parentColumn: _parentColumn, ...named } = child;
    return { ...named, rows, referencing, orphans };
  });
  const naming = (action: string) =>
    referencedBy.filter((child) => child.onDelete === action).map((child) => `${child.table}.${child.column}`);
  return {
    table,
    rows: db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0,
    referencedBy: referencedBy.sort(
      (left, right) => right.orphans - left.orphans || left.table.localeCompare(right.table),
    ),
    refuses: [...naming("NO ACTION"), ...naming("RESTRICT")].sort(),
    cascades: naming("CASCADE").sort(),
    clears: naming("SET NULL").sort(),
    deletionOrder: order(byParent, table),
  };
}
