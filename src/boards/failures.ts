/**
 * A board Discord refuses, remembered.
 *
 * The channel still holds the last version that worked, so a board that cannot be sent looks
 * exactly like a board with nothing new to say. Storing the refusal is what lets `issues` and the
 * alert channel say it out loud. It reads and writes app_state, which is why it is not in with the
 * files that only draw.
 */

import type { Database } from "bun:sqlite";
import { clearState, readState, writeState } from "../storage/appState.js";
import type { BoardKey } from "./keys.js";

const BOARD_FAILURE_PREFIX = "board_failure:";
export type BoardFailure = { board: BoardKey; reason: string; firstSeenAt: string; updatedAt: string };

/**
 * A board that cannot be sent is the one failure this service used to keep to itself: the channel
 * still holds a plausible board, and a stale board looks exactly like a quiet one. Storing the
 * refusal is what lets `issues` and the alert channel say it out loud.
 */
export function recordBoardFailure(db: Database, board: BoardKey, reason: string, now: number): void {
  const key = `${BOARD_FAILURE_PREFIX}${board}`;
  const existing = readState(db, key);
  let firstSeenAt = new Date(now).toISOString();
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as Partial<BoardFailure>;
      if (parsed.firstSeenAt && Number.isFinite(Date.parse(parsed.firstSeenAt))) firstSeenAt = parsed.firstSeenAt;
    } catch {
      // A value this service cannot read is replaced by one it can.
    }
  }
  const value = JSON.stringify({ board, reason, firstSeenAt, updatedAt: new Date(now).toISOString() });
  writeState(db, key, value);
}

export function clearBoardFailure(db: Database, board: BoardKey): void {
  clearState(db, `${BOARD_FAILURE_PREFIX}${board}`);
}

/** Every board Discord is currently refusing, for the read model that has to report it. */
export function boardFailures(db: Database): BoardFailure[] {
  return db
    .query<{ key: string; value: string }, [string]>("SELECT key,value FROM app_state WHERE key LIKE ? ORDER BY key")
    .all(`${BOARD_FAILURE_PREFIX}%`)
    .flatMap((row) => {
      try {
        const parsed = JSON.parse(row.value) as BoardFailure;
        return parsed.board && parsed.reason ? [parsed] : [];
      } catch {
        return [];
      }
    });
}
