import { expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import { type Collection, prepareDeliveries, saveCollection } from "../src/events.js";
import { openDatabase } from "../src/storage/database.js";

const destination: Destination = {
  id: "discord",
  platform: "discord",
  channelId: "123",
  signals: ["launch", "codename", "evidence", "change"],
};

function collection(records: Collection["records"]): Collection {
  return {
    source: "designarena:image",
    stream: "leaderboards",
    url: "https://www.designarena.ai/leaderboard/image",
    raw: records,
    trackChanges: true,
    records,
  };
}

/** The text boards, where a change of first place is a change in the state of the art. */
function textBoard(records: Collection["records"]): Collection {
  return {
    source: "arena-leaderboards",
    stream: "leaderboards",
    url: "https://lmarena.ai/leaderboard",
    raw: records,
    trackChanges: true,
    records,
  };
}

function model(id: string, rank: number): Collection["records"][number] {
  return { id, name: id, category: "designarena/image", rank };
}

function ranked(id: string, rank: number): Collection["records"][number] {
  return { id, name: id, category: "text/overall", rank };
}

function deliveries(db: ReturnType<typeof openDatabase>): { body: string }[] {
  return db.query<{ body: string }, []>("SELECT body FROM deliveries ORDER BY id").all();
}

test("first-place movement is immediate, stable rechecks are silent, and a real reversal is sent once", () => {
  const db = openDatabase(":memory:");
  saveCollection(db, textBoard([ranked("riverflow-2.5-pro", 2)]), [destination], "2026-09-10T10:00:00.000Z");
  expect(
    saveCollection(db, textBoard([ranked("riverflow-2.5-pro", 1)]), [destination], "2026-09-10T10:05:00.000Z"),
  ).toBe(1);

  expect(deliveries(db)).toHaveLength(1);
  expect(db.query<{ digest: number }, []>("SELECT digest FROM batches").all()).toEqual([{ digest: 0 }]);
  const first = JSON.parse(deliveries(db)[0]?.body ?? "{}") as {
    embeds: { author: { name: string }; description: string; url: string }[];
  };
  expect(first.embeds[0]?.author.name).toBe("ARENA · LEADERBOARDS");
  // The board is reachable through the card title rather than through a line of the body.
  expect(first.embeds[0]?.url).toBe("https://lmarena.ai/leaderboard");
  expect(first.embeds[0]?.description).toContain("Rank 1 🔼 1 (was 2)");

  expect(
    saveCollection(db, textBoard([ranked("riverflow-2.5-pro", 1)]), [destination], "2026-09-10T10:10:00.000Z"),
  ).toBe(0);
  expect(deliveries(db)).toHaveLength(1);

  expect(
    saveCollection(db, textBoard([ranked("riverflow-2.5-pro", 2)]), [destination], "2026-09-10T10:15:00.000Z"),
  ).toBe(1);
  expect(deliveries(db)).toHaveLength(2);
  const second = JSON.parse(deliveries(db)[1]?.body ?? "{}") as { embeds: { description: string }[] };
  expect(second.embeds[0]?.description).toContain("Rank 2 🔽 1 (was 1)");
  db.close();
});

test("taking first place on a design board is not news; arriving on it is", () => {
  const db = openDatabase(":memory:");
  saveCollection(db, collection([model("riverflow-2.5-pro", 2)]), [destination], "2026-09-10T10:00:00.000Z");
  // A design board is voted on all day. Who is first today says nothing about what is new.
  saveCollection(db, collection([model("riverflow-2.5-pro", 1)]), [destination], "2026-09-10T10:05:00.000Z");
  expect(deliveries(db)).toHaveLength(0);

  saveCollection(
    db,
    collection([model("riverflow-2.5-pro", 1), model("gpt-6-astra", 2)]),
    [destination],
    "2026-09-10T10:10:00.000Z",
  );
  // An arrival travels with the hourly digest, which is where board movement belongs.
  prepareDeliveries(db, Date.parse("2026-09-10T11:05:00.000Z"));
  const bodies = deliveries(db).map((row) => row.body);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toContain("gpt-6-astra");
  db.close();
});

test("a leaderboard departure waits for two successful snapshots and does not report a transient miss", () => {
  const db = openDatabase(":memory:");
  const present = [model("riverflow-2.5-pro", 1), model("other-model", 2)];
  saveCollection(db, collection(present), [destination], "2026-09-10T11:00:00.000Z");
  saveCollection(db, collection(present), [destination], "2026-09-10T11:05:00.000Z");

  const missing = [model("other-model", 2)];
  expect(saveCollection(db, collection(missing), [destination], "2026-09-10T11:10:00.000Z")).toBe(0);
  expect(deliveries(db)).toHaveLength(0);

  expect(saveCollection(db, collection(missing), [destination], "2026-09-10T11:15:00.000Z")).toBe(1);
  const body = JSON.parse(deliveries(db)[0]?.body ?? "{}") as { embeds: { description: string }[] };
  expect(body.embeds[0]?.description).toContain("Leaves designarena/image");
  expect(body.embeds[0]?.description).toContain("Last observed rank: 1");
  expect(deliveries(db)).toHaveLength(1);
  db.close();
});
