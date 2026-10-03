import { expect, test } from "bun:test";
import { dislikedCards } from "../src/reports/disliked.js";
import { openDatabase } from "../src/storage/database.js";

const at = "2026-09-20T00:00:00.000Z";
const now = Date.parse("2026-09-24T00:00:00.000Z");

/** A card as the tables hold one: a batch, a delivery per channel, and the events it carried. */
function newsroom(): ReturnType<typeof openDatabase> {
  const db = openDatabase(":memory:");
  db.exec("INSERT INTO snapshots(id,source,collected_at) VALUES(1,'x','2026-09-01T00:00:00.000Z')");
  let next = 0;
  const card = (
    source: string,
    record: Record<string, unknown>,
    channels: readonly string[],
    against: number,
    headline = "a card",
  ) => {
    next += 1;
    const eventId = next * 10;
    db.query(
      `INSERT INTO events(id,source,stream,entity_id,kind,after_json,detected_at,snapshot_id,confidence,evidence_type,authority,signal)
       VALUES(?,?,'leaderboards',?,'new',?,?,1,'observed','status_page','third_party','debut')`,
    ).run(eventId, source, `row-${eventId}`, JSON.stringify(record), at);
    db.query("INSERT INTO batches(id,source,digest,ready_at,kind) VALUES(?,?,0,?,'event')").run(next, source, at);
    for (const [index, channel] of channels.entries()) {
      const deliveryId = next * 10 + index;
      db.query(
        `INSERT INTO deliveries(id,batch_id,destination_id,destination_json,body,part,status,updated_at)
         VALUES(?,?,?,'{}',?,0,'sent',?)`,
      ).run(deliveryId, next, channel, JSON.stringify({ embeds: [{ title: headline }] }), at);
      db.query("INSERT INTO delivery_events(delivery_id,event_id) VALUES(?,?)").run(deliveryId, eventId);
      if (index === 0 && against > 0)
        db.query("INSERT INTO scout_reactions(delivery_id,votes,against,read_at) VALUES(?,0,?,?)").run(
          deliveryId,
          against,
          at,
        );
    }
  };
  card(
    "arena-leaderboards",
    { category: "vision/overall", maker: "SpaceXAI" },
    ["tg-news", "discord-signals"],
    1,
    "a vision debut",
  );
  card("arena-leaderboards", { category: "image-edit/overall", maker: "SpaceXAI" }, ["tg-news"], 1);
  card("arena-leaderboards", { category: "code/overall", maker: "Anthropic" }, ["tg-news"], 0);
  card("arena-leaderboards", { category: "code/overall", maker: "OpenAI" }, ["tg-news"], 0);
  return db;
}

test("the cards a reader marked are laid out with the handles a rule could cut them by", () => {
  const report = dislikedCards(newsroom(), 14, now);
  expect(report.cards).toHaveLength(2);
  const [first] = report.cards;
  expect(first?.headline).toBe("a vision debut");
  // The same batch reached a second channel, so "not here" stays a possible answer beside "not at all".
  expect(first?.alsoSentTo).toEqual(["discord-signals"]);
  expect(first?.facets).toContainEqual({ axis: "board", value: "vision/overall" });
  // Derived, because no source has a field for it: a vision board and an image-edit board are both
  // the modality a coding channel does not read.
  expect(first?.facets).toContainEqual({ axis: "modality", value: "image" });
});

test("a cut carries what it would also take, and the code cards nobody marked are not in it", () => {
  const report = dislikedCards(newsroom(), 14, now);
  const image = report.cuts.find((cut) => cut.axis === "modality" && cut.value === "image");
  // A card is a card in a channel, so the vision debut that went to two counts twice in what the
  // cut would take: two marked out of three sent, and nobody asked for the third either.
  expect(image).toMatchObject({ disliked: 2, cards: 3, destinations: ["tg-news"] });
  // The source is the same for all four, so it is a cut that would take the two code cards too.
  expect(report.cuts.find((cut) => cut.axis === "source")).toMatchObject({ disliked: 2, cards: 5 });
  expect(report.cuts.some((cut) => cut.value === "code")).toBe(false);
  expect(report.channels).toContainEqual({ destination: "tg-news", cards: 4, disliked: 2 });
});
