import { expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import { prepareDeliveries } from "../src/events/batching.js";
import { releaseSettledMoves } from "../src/events/cooldown.js";
import { saveCollection } from "../src/events/pipeline.js";
import type { Collection } from "../src/events/types.js";
import { openDatabase } from "../src/storage/database.js";

const destination: Destination = { id: "changes", platform: "discord", channelId: "1", signals: ["change"] };

const catalogue = (price: string): Collection => ({
  source: "vercel-gateway",
  stream: "api-models",
  url: "https://openrouter.ai/models",
  raw: [],
  records: [{ id: "moonshotai/kimi-k3", name: "MoonshotAI: Kimi K3", pricing: { completion: price } }],
});

/** Renders the cards a destination would receive, newest last. */
function cards(db: ReturnType<typeof openDatabase>): string[] {
  return db
    .query<{ body: string }, []>("SELECT body FROM deliveries ORDER BY id")
    .all()
    .flatMap((row) => {
      const payload = JSON.parse(row.body) as {
        embeds?: { description?: string; fields?: { name: string; value: string }[] }[];
        banners?: { chips: string[] }[];
      };
      // What the card says, in reading order: its sentences, then its labelled facts.
      // A price card's move is on its banner, not in its text.
      return (payload.embeds ?? []).map((embed, index) =>
        [
          embed.description ?? "",
          ...(embed.fields ?? []).map((field) => `${field.name}: ${field.value}`),
          ...(payload.banners?.[index]?.chips ?? []),
        ].join("\n"),
      );
    });
}

test("a price that slides all day is one message about the whole slide, not six about each step", () => {
  const db = openDatabase(":memory:");
  const hour = 3_600_000;
  const start = Date.parse("2026-09-11T01:00:00.000Z");
  // $15 → $13 → $11.70 → $10.53 → $9.48, one step an hour, exactly as Kimi K3 moved.
  const steps = ["0.000015", "0.000013", "0.0000117", "0.00001053", "0.00000948"];
  steps.forEach((price, index) => {
    saveCollection(db, catalogue(price), [destination], new Date(start + index * hour).toISOString());
    prepareDeliveries(db, start + index * hour + hour / 2);
  });

  const delivered = cards(db);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toContain("$15 → $13 per 1M");
  db.close();
});

test("once the wait is over the card covers the whole move, not the last step", () => {
  const db = openDatabase(":memory:");
  const hour = 3_600_000;
  const start = Date.parse("2026-09-11T01:00:00.000Z");
  const steps = ["0.000015", "0.000013", "0.0000117", "0.00001053", "0.00000948"];
  steps.forEach((price, index) => {
    saveCollection(db, catalogue(price), [destination], new Date(start + index * hour).toISOString());
    prepareDeliveries(db, start + index * hour + hour / 2);
  });
  // Once six hours have passed since the first card was rendered, the held drift is released and
  // speaks, with no newer step needed to wake it.
  releaseSettledMoves(db, start + 9 * hour);
  prepareDeliveries(db, start + 9 * hour);

  const delivered = cards(db);
  expect(delivered).toHaveLength(2);
  // The reader last saw $13 and the price is now $9.48. The steps in between are in the database,
  // not in the message: one card covers the whole move that reader missed.
  expect(delivered[1]).toContain("$13 → $9.48 per 1M");
  expect(delivered[1]).not.toContain("$11.7");
  db.close();
});

test("a move that returns to the state a destination last saw says nothing", () => {
  const db = openDatabase(":memory:");
  const hour = 3_600_000;
  const start = Date.parse("2026-09-11T01:00:00.000Z");
  saveCollection(db, catalogue("0.000015"), [destination], new Date(start).toISOString());
  saveCollection(db, catalogue("0.000013"), [destination], new Date(start + hour).toISOString());
  prepareDeliveries(db, start + 2 * hour);
  expect(cards(db)).toHaveLength(1);

  // Seven hours later it is back where the reader last saw it.
  const later = start + 8 * hour;
  saveCollection(db, catalogue("0.000015"), [destination], new Date(later).toISOString());
  prepareDeliveries(db, later + hour / 2);
  expect(cards(db)).toHaveLength(1);
  db.close();
});

test("a first change for a subject never waits", () => {
  const db = openDatabase(":memory:");
  const start = Date.parse("2026-09-11T01:00:00.000Z");
  saveCollection(db, catalogue("0.000015"), [destination], new Date(start).toISOString());
  saveCollection(db, catalogue("0.000013"), [destination], new Date(start + 3_600_000).toISOString());
  prepareDeliveries(db, start + 2 * 3_600_000);
  expect(cards(db)).toHaveLength(1);
  db.close();
});

test("steps too small to report on their own add up to one card", () => {
  const db = openDatabase(":memory:");
  const hour = 3_600_000;
  const start = Date.parse("2026-09-11T01:00:00.000Z");
  // $1.896 → $1.720 → $1.630 → $1.560: −9.3%, −5.2% and −4.3%, every step under the ten percent
  // that makes a price worth reporting, and −17.7% together.
  const steps = ["0.000001896", "0.00000172", "0.00000163", "0.00000156"];
  steps.forEach((price, index) => {
    saveCollection(db, catalogue(price), [destination], new Date(start + index * hour).toISOString());
    prepareDeliveries(db, start + (index + 1) * hour);
  });

  const delivered = cards(db);
  expect(delivered).toHaveLength(1);
  // It speaks as soon as the accumulated drift crosses the line, and the card covers the whole
  // drift rather than the small step that happened to cross it.
  expect(delivered[0]).toContain("$1.9 → $1.63 per 1M");
  db.close();
});

/**
 * A hold is a decision about one batch, and corroboration sends a card for the same event from a
 * batch of its own: the Mistral Large 4 Preview debut went to the scouts at 14:03 on 2026-10-06 and
 * the released hold repeated it, identically, at 15:00.
 */
test("a held move another producer has already sent is dropped, not released into a second card", () => {
  const db = openDatabase(":memory:");
  db.exec("INSERT INTO snapshots(id,source,collected_at) VALUES(1,'vercel-gateway','2026-10-06T13:00:00.000Z')");
  db.exec(
    `INSERT INTO events(id,source,stream,entity_id,kind,after_json,detected_at,snapshot_id,authority)
     VALUES(1,'artificial-analysis','leaderboards','mistral-large-4-preview','new',
            '{"name":"Mistral Large 4 Preview"}','2026-10-06T13:03:00.000Z',1,'third_party')`,
  );
  // The batch the hold was written against, and the room it was held for.
  db.exec(
    "INSERT INTO batches(id,source,digest,ready_at) VALUES(1,'artificial-analysis',0,'2026-10-06T13:03:00.000Z')",
  );
  db.exec("INSERT INTO batch_events(batch_id,event_id,url,signal) VALUES(1,1,'','codename')");
  db.exec(
    `INSERT INTO batch_targets(batch_id,destination_id,destination_json)
     VALUES(1,'changes','${'{"id":"changes","platform":"discord","channelId":"1","signals":["change"]}'}')`,
  );
  db.exec(
    `INSERT INTO suppressions(event_id,destination_id,batch_id,reason,detail,recorded_at)
     VALUES(1,'changes',1,'waiting_for_the_move_to_settle','heard about this subject recently','2026-10-06T13:03:00.000Z')`,
  );
  // Meanwhile corroboration carded the very same event into the very same room.
  db.exec(
    "INSERT INTO batches(id,source,digest,ready_at) VALUES(2,'artificial-analysis',0,'2026-10-06T13:03:30.000Z')",
  );
  db.exec("INSERT INTO batch_events(batch_id,event_id,url,signal) VALUES(2,1,'','codename')");
  db.exec(
    `INSERT INTO deliveries(batch_id,destination_id,destination_json,body,part,status,updated_at)
     VALUES(2,'changes','{}','{"embeds":[]}',0,'sent','2026-10-06T13:03:30.000Z')`,
  );

  expect(releaseSettledMoves(db, Date.parse("2026-10-06T22:00:00.000Z"))).toBe(0);
  // And the hold is gone rather than reconsidered on every pass forever.
  expect(db.query<{ n: number }, []>("SELECT count(*) n FROM suppressions").get()?.n).toBe(0);
  db.close();
});
