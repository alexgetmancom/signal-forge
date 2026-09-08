import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/database.js";

test("migration preserves existing delivery IDs, outcomes and event evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "signal-forge-migration-"));
  const path = join(dir, "app.db");
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE events(id INTEGER PRIMARY KEY,source TEXT,stream TEXT,entity_id TEXT,kind TEXT,before_json TEXT,after_json TEXT,detected_at TEXT,snapshot_id INTEGER);
    INSERT INTO events VALUES(7,'test','news','x','new',NULL,'{}','2026-09-08',1);
    CREATE TABLE deliveries(id INTEGER PRIMARY KEY,event_id INTEGER REFERENCES events(id),destination_id TEXT,destination_json TEXT,body TEXT,part INTEGER,status TEXT,attempts INTEGER,next_attempt INTEGER,external_id TEXT,error TEXT,updated_at INTEGER,UNIQUE(event_id,destination_id,part));
    INSERT INTO deliveries VALUES(42,7,'tg','{}','already sent',0,'sent',1,0,'123',NULL,1);
    INSERT INTO deliveries VALUES(43,7,'dc','{}','pending',0,'pending',0,0,NULL,NULL,1);
  `);
  legacy.close();
  try {
    let db = openDatabase(path);
    expect(db.query("SELECT id,batch_id,status,external_id FROM deliveries ORDER BY id").all()).toEqual([
      { id: 42, batch_id: 7, status: "sent", external_id: "123" },
      { id: 43, batch_id: 7, status: "pending", external_id: null },
    ]);
    expect(db.query("SELECT event_id FROM batch_events").all()).toEqual([{ event_id: 7 }]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
    db = openDatabase(path);
    expect(db.query("SELECT COUNT(*) AS n FROM deliveries").get()).toEqual({ n: 2 });
    db.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
