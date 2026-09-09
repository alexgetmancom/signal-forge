import { loadConfig } from "../src/config.js";
import { canonical } from "../src/events/canonical.js";
import type { RecordData } from "../src/events/types.js";
import { selectMeaningfulWebStrings } from "../src/events/web.js";
import { openDatabase } from "../src/storage/database.js";

const SOURCE = "claude-web";
const config = loadConfig();
const db = openDatabase(config.DATABASE_URL);
let updated = 0;

try {
  const rows = db
    .query<{ id: string; body: string }, [string]>("SELECT id, body FROM records WHERE source=?")
    .all(SOURCE);

  db.transaction(() => {
    for (const row of rows) {
      const parsed: unknown = JSON.parse(row.body);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        typeof (parsed as Record<string, unknown>).id !== "string" ||
        typeof (parsed as Record<string, unknown>).name !== "string" ||
        !Array.isArray((parsed as Record<string, unknown>).strings)
      ) {
        throw new Error(`Invalid ${SOURCE} record ${row.id}`);
      }

      const record = parsed as RecordData & { strings: unknown[] };
      const next = canonical({
        ...record,
        name: "Claude: public interface strings",
        strings: selectMeaningfulWebStrings(record.strings),
      });
      if (next === row.body) continue;

      db.query("UPDATE records SET body=?,missing_count=0 WHERE source=? AND id=?").run(next, SOURCE, row.id);
      updated++;
    }
    db.query("DELETE FROM change_candidates WHERE source=?").run(SOURCE);
  })();

  console.log(`Normalized ${updated} Claude Web records`);
} finally {
  db.close();
}
