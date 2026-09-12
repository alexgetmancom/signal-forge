import { canonical } from "../src/events/canonical.js";
import { leaderboardRecordsFromRaw } from "../src/sources/arena.js";
import { openDatabase } from "../src/storage/database.js";
import { readLatestSnapshot } from "../src/storage/snapshots.js";

const db = openDatabase("/app/data/app.db");
const snapshot = readLatestSnapshot(db, "arena-leaderboards");

if (!snapshot) {
  console.log("No Arena leaderboard snapshot found; no backfill required");
  db.close();
} else {
  const records = leaderboardRecordsFromRaw(JSON.parse(snapshot));
  let updated = 0;
  db.transaction(() => {
    db.query("DELETE FROM change_candidates WHERE source='arena-leaderboards'").run();
    for (const record of records) {
      const result = db
        .query("UPDATE records SET body=?,missing_count=0 WHERE source='arena-leaderboards' AND id=?")
        .run(canonical(record), record.id);
      updated += result.changes;
    }
  })();
  console.log(`Backfilled ${updated} Arena leaderboard records`);
  db.close();
}
