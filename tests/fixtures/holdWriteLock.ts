/**
 * Another process holding the write lock of a database for a while, and then letting go.
 *
 * Run as `bun holdWriteLock.ts <database> <milliseconds>`. It says `locked` once it holds the lock,
 * so a test knows the moment from which it is the second writer. A second connection in the test's
 * own process cannot stand in: the one waiting blocks the thread the holder would release from.
 */
import { Database } from "bun:sqlite";

const [path = "", milliseconds = "0"] = process.argv.slice(2);
const db = new Database(path);
db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
db.exec("INSERT INTO held(x) VALUES('the other writer')");
console.log("locked");
await Bun.sleep(Number(milliseconds));
db.exec("COMMIT");
db.close();
