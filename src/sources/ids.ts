/**
 * Two entries that read as one id, and what to do about it.
 *
 * `persistCollection` refuses a collection with a repeated id whole, and what it refuses is every
 * record of the source: one pair of entries of a day under one title stopped a release-notes page
 * and every note on it. Which of the two remedies is right depends on what the repeat is, and only
 * the collector knows.
 */

/**
 * Entries that are two things sharing a name -- two notes of one day under one title. Both are kept
 * and the later arrival takes a suffix.
 *
 * The suffix goes to the later arrival. Pages list the newest first, so the walk is from the end: the
 * entry that has been there longest keeps its id and a duplicate added above it is `-2`, and no stored
 * record changes id because another one joined it. A suffix that is itself an id on the page is skipped.
 * Ids that were unique stay exactly as they were.
 */
export function distinctIds<T extends { id: string }>(records: readonly T[]): T[] {
  const taken = new Set(records.map((record) => record.id));
  const seen = new Map<string, number>();
  return [...records]
    .reverse()
    .map((record) => {
      const before = seen.get(record.id) ?? 0;
      seen.set(record.id, before + 1);
      if (before === 0) return record;
      let n = before + 1;
      while (taken.has(`${record.id}-${n}`)) n += 1;
      const id = `${record.id}-${n}`;
      taken.add(id);
      return { ...record, id };
    })
    .reverse();
}

/**
 * One thing listed twice -- an index that names a page under two sections, a feed that repeats an
 * item, a page boundary that moved between two requests. The first listing stays.
 */
export function firstOfEach<T extends { id: string }>(records: readonly T[]): T[] {
  const seen = new Set<string>();
  return records.filter((record) => !seen.has(record.id) && seen.add(record.id));
}

/**
 * Rows that say the same thing under one id, folded into one: the last stands, in the place the first
 * held. It is the expression `new Map(rows.map((row) => [row.id, row])).values()` that a lifecycle
 * parser wrote three times, with what it dropped counted instead of invisible.
 */
export function lastOfEach<T extends { id: string }>(records: readonly T[]): { kept: T[]; merged: number } {
  const byId = new Map(records.map((record) => [record.id, record]));
  return { kept: [...byId.values()], merged: records.length - byId.size };
}
