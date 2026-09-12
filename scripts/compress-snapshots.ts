/**
 * Rewrites payloads collected before they were stored compressed.
 *
 * One row at a time on purpose: a single stored page is 21 MB, and reading many at once is what
 * killed this service twice. Safe to run again — a row that already has a body is skipped.
 */
import { openDatabase } from "../src/storage/database.js";
import { hashPayload } from "../src/storage/snapshots.js";

const path = process.argv[2] ?? process.env.DATABASE_URL;
if (!path) throw new Error("Usage: bun scripts/compress-snapshots.ts <database>");

// Opening through the normal path applies any pending migration first, so the columns this writes
// into are guaranteed to exist.
const db = openDatabase(path);
db.query("PRAGMA busy_timeout=60000").get();

const pending = db
  .query<{ id: number }, []>("SELECT id FROM snapshots WHERE body IS NULL AND raw_json <> '' ORDER BY id")
  .all();
process.stdout.write(`${pending.length} payloads to compress\n`);

let raw = 0;
let packed = 0;
for (const [index, row] of pending.entries()) {
  const stored = db.query<{ raw_json: string }, [number]>("SELECT raw_json FROM snapshots WHERE id=?").get(row.id);
  if (!stored?.raw_json) continue;
  const body = Bun.gzipSync(Buffer.from(stored.raw_json));
  const bytes = Buffer.byteLength(stored.raw_json);
  db.query("UPDATE snapshots SET body=?,hash=?,bytes=?,raw_json='' WHERE id=?").run(
    body,
    hashPayload(stored.raw_json),
    bytes,
    row.id,
  );
  raw += bytes;
  packed += body.length;
  if ((index + 1) % 50 === 0) process.stdout.write(`  ${index + 1} of ${pending.length}\n`);
}

const mb = (bytes: number) => (bytes / 1_048_576).toFixed(1);
process.stdout.write(`compressed ${mb(raw)} MB into ${mb(packed)} MB\n`);
