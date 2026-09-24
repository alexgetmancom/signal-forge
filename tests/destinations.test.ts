import { expect, test } from "bun:test";
import type { AppConfig } from "../src/config.js";
import { destinationStandings } from "../src/reports/destinations.js";
import { openDatabase } from "../src/storage/database.js";

const NOW = new Date("2026-09-25T00:00:00.000Z");

function setup() {
  const db = openDatabase(":memory:");
  const send = (id: number, destination: string, at: string, status = "sent") => {
    db.exec(`INSERT INTO batches(id,source,digest,ready_at,kind) VALUES(${id},'x',0,'${at}','event')`);
    db.query(
      `INSERT INTO deliveries(id,batch_id,destination_id,destination_json,body,part,status,updated_at)
       VALUES(?,?,?,'{}','body',0,?,?)`,
    ).run(id, id, destination, status, at);
  };
  return { db, send };
}

const config = (...ids: string[]) =>
  ({
    destinations: ids.map((id) => ({ id, platform: "discord", channelId: "1", signals: ["launch"] })),
  }) as unknown as AppConfig;

test("a destination the registry does not configure is reported retired, not broken", () => {
  const { db, send } = setup();
  send(1, "discord-signals", "2026-09-24T10:00:00.000Z");
  send(2, "discord-web-watcher", "2026-09-09T10:00:00.000Z");

  const standings = destinationStandings(db, config("discord-signals"), 30, NOW);
  // Grouping deliveries by destination_id alone reports two channels and says nothing about which
  // of them anyone still expects to hear from. That reading produced a wrong finding on 2026-09-24.
  expect(standings.map((entry) => [entry.id, entry.live])).toEqual([
    ["discord-signals", true],
    ["discord-web-watcher", false],
  ]);
  expect(standings[1]?.quietDays).toBe(15);
  expect(standings[1]?.attention).toBeUndefined();
  db.close();
});

test("a channel sending yesterday that the registry has never heard of is the registry's problem", () => {
  const { db, send } = setup();
  send(1, "tg-news", "2026-09-24T16:00:00.000Z");

  const [standing] = destinationStandings(db, config("discord-signals"), 30, NOW);
  // This is what reading the report against a stale local config looks like, and it is worth
  // saying out loud rather than rendering as a retired channel that happens to be busy.
  expect(standing?.id).toBe("discord-signals");
  const unregistered = destinationStandings(db, config("discord-signals"), 30, NOW)[1];
  expect(unregistered?.id).toBe("tg-news");
  expect(unregistered?.live).toBe(false);
  expect(unregistered?.attention).toContain("not in this deployment's registry");
  db.close();
});

test("a live channel that has heard nothing is quiet, and a card with no events is counted", () => {
  const { db, send } = setup();
  send(1, "discord-scouts", "2026-09-18T00:00:00.000Z");
  const [scouts] = destinationStandings(db, config("discord-scouts"), 30, NOW);
  expect(scouts?.quietDays).toBe(7);
  // An event card that recorded nothing about which events it carried: the real gap, at its real size.
  expect(scouts?.unlinkedCards).toBe(1);
  db.exec("INSERT INTO snapshots(id,source,collected_at) VALUES(1,'x','2026-09-18T00:00:00.000Z')");
  db.exec(
    `INSERT INTO events(id,source,stream,entity_id,kind,detected_at,snapshot_id,confidence,evidence_type,authority)
     VALUES(1,'x','leaderboards','e','new','2026-09-18T00:00:00.000Z',1,'observed','leaderboard','third_party')`,
  );
  db.query("INSERT INTO delivery_events(delivery_id,event_id) VALUES(1,1)").run();
  expect(destinationStandings(db, config("discord-scouts"), 30, NOW)[0]?.unlinkedCards).toBe(0);
  db.close();
});
