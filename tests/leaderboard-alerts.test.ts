import { expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import { type Collection, saveCollection } from "../src/events.js";
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

function model(id: string, rank: number): Collection["records"][number] {
  return { id, name: id, category: "designarena/image", rank };
}

function deliveries(db: ReturnType<typeof openDatabase>): { body: string }[] {
  return db.query<{ body: string }, []>("SELECT body FROM deliveries ORDER BY id").all();
}

test("first-place movement is immediate, stable rechecks are silent, and a real reversal is sent once", () => {
  const db = openDatabase(":memory:");
  saveCollection(db, collection([model("riverflow-2.5-pro", 2)]), [destination], "2026-09-10T10:00:00.000Z");
  expect(
    saveCollection(db, collection([model("riverflow-2.5-pro", 1)]), [destination], "2026-09-10T10:05:00.000Z"),
  ).toBe(1);

  expect(deliveries(db)).toHaveLength(1);
  expect(db.query<{ digest: number }, []>("SELECT digest FROM batches").all()).toEqual([{ digest: 0 }]);
  const first = JSON.parse(deliveries(db)[0]?.body ?? "{}") as {
    embeds: { author: { name: string }; description: string }[];
  };
  expect(first.embeds[0]?.author.name).toBe("DESIGNARENA · IMAGE");
  expect(first.embeds[0]?.description).toContain("https://www.designarena.ai/leaderboard/image");
  expect(first.embeds[0]?.description).toContain("Benchmark: designarena/image");
  expect(first.embeds[0]?.description).toContain("Rank 1 🔼 1 (was 2)");

  expect(
    saveCollection(db, collection([model("riverflow-2.5-pro", 1)]), [destination], "2026-09-10T10:10:00.000Z"),
  ).toBe(0);
  expect(deliveries(db)).toHaveLength(1);

  expect(
    saveCollection(db, collection([model("riverflow-2.5-pro", 2)]), [destination], "2026-09-10T10:15:00.000Z"),
  ).toBe(1);
  expect(deliveries(db)).toHaveLength(2);
  const second = JSON.parse(deliveries(db)[1]?.body ?? "{}") as { embeds: { description: string }[] };
  expect(second.embeds[0]?.description).toContain("Rank 2 🔽 1 (was 1)");
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
