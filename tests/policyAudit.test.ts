import { expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import { prepareDeliveries } from "../src/events/batching.js";
import { saveCollection } from "../src/events/pipeline.js";
import type { Collection } from "../src/events/types.js";
import { lateArrivals } from "../src/reports/lateArrivals.js";
import { why } from "../src/reports/why.js";
import { openDatabase } from "../src/storage/database.js";

const wire: Destination = {
  id: "scouts",
  platform: "discord",
  channelId: "1",
  signals: ["launch", "codename", "rank", "change", "evidence", "article", "business", "release", "incident"],
};

/** A lab's own organisation listing: one repository published yesterday, one published a year ago. */
function listing(at: string, extra: Collection["records"] = []): Collection {
  return {
    source: "huggingface:tencent",
    stream: "weights",
    url: "https://huggingface.co/api/models?author=tencent",
    raw: [],
    appendOnly: true,
    records: [{ id: "tencent/anchor", name: "tencent/anchor", pipeline: "text-generation", created: at }, ...extra],
  };
}

function populate(db: ReturnType<typeof openDatabase>) {
  const now = new Date();
  const iso = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
  saveCollection(db, listing(iso(1)), [wire], iso(2));
  const second = listing(iso(1), [
    // Published a year before this reading of it: the back catalogue a widened window finds.
    { id: "tencent/old-weights", name: "tencent/old-weights", pipeline: "text-generation", created: iso(365) },
    // Published yesterday: the one thing here that is news.
    { id: "tencent/new-weights", name: "tencent/new-weights", pipeline: "text-generation", created: iso(1) },
  ]);
  saveCollection(db, second, [wire], iso(0));
  prepareDeliveries(db, now.getTime());
  return Object.fromEntries(
    db
      .query<{ id: number; entity_id: string }, []>("SELECT id,entity_id FROM events WHERE kind='new'")
      .all()
      .map((row) => [row.entity_id, row.id]),
  ) as Record<string, number>;
}

test("why says which rule held an event, and which questions a batch of one cannot answer", () => {
  const db = openDatabase(":memory:");
  const ids = populate(db);
  const answer = why(db, ids["tencent/old-weights"] ?? 0);
  expect(answer).not.toBeNull();
  expect(answer?.replay.heldBy).toBe("published_long_before_we_read_it");
  // The stored half agrees here, which is the ordinary case; the two disagreeing is the finding.
  expect(answer?.stored.heldBy.map((one) => one.reason)).toEqual(["published_long_before_we_read_it"]);
  // Every question is reported, not just the deciding one.
  expect(answer?.replay.answers.length).toBeGreaterThan(20);
  expect(answer?.replay.answers.at(0)?.check).toBe("renamed_by_the_source");
  // And the ones a single event cannot speak for are named rather than reported as a pass.
  expect(answer?.cannotBeReplayed).toContain("one_change_across_the_whole_list");

  // The repository published yesterday is held by nothing.
  expect(why(db, ids["tencent/new-weights"] ?? 0)?.replay.heldBy).toBeNull();
  expect(why(db, 99_999)).toBeNull();
  db.close();
});

test("late-arrivals counts a back catalogue that was held, and sends nothing to explain", () => {
  const db = openDatabase(":memory:");
  populate(db);
  const report = lateArrivals(db, 7, 50);
  // Held late is the rule working; sent late is the rule having a gap, and there is none here.
  expect(report.summary.heldLate).toBe(1);
  expect(report.summary.deliveredLate).toBe(0);
  expect(report.sent).toEqual([]);
  expect(report.bySource).toEqual([]);
  db.close();
});
