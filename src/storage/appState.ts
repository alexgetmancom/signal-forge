import type { Database } from "bun:sqlite";

/** The stored value for one app_state key, or null when nothing is stored under it. */
export function readState(db: Database, key: string): string | null {
  return db.query<{ value: string }, [string]>("SELECT value FROM app_state WHERE key=?").get(key)?.value ?? null;
}

export function writeState(db: Database, key: string, value: string): void {
  db.query("INSERT INTO app_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    key,
    value,
  );
}

export function clearState(db: Database, key: string): void {
  db.query("DELETE FROM app_state WHERE key=?").run(key);
}
