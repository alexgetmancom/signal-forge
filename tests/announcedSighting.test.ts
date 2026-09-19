import { expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import { prepareDeliveries } from "../src/events/batching.js";
import { saveCollection } from "../src/events/pipeline.js";
import type { Collection } from "../src/events/types.js";
import { openDatabase } from "../src/storage/database.js";

const signals: Destination = {
  id: "signals",
  platform: "discord",
  channelId: "1",
  signals: ["launch", "release", "feature"],
};
const scouts: Destination = { id: "scouts", platform: "discord", channelId: "2", signals: ["codename"] };

test("a vendor page about a release its maker already announced is not a sighting", () => {
  const db = openDatabase(":memory:");
  const notes: Collection = {
    source: "xai-release-notes",
    stream: "news",
    url: "https://docs.x.ai/release-notes",
    raw: [],
    records: [
      { id: "2026-09-01:old", name: "Older note", url: "https://docs.x.ai/old", published: "2026-09-01T00:00:00.000Z" },
    ],
  };
  const pages: Collection = {
    source: "pages:xai",
    stream: "pages",
    url: "https://x.ai/sitemap.xml",
    raw: [],
    records: [
      {
        id: "/news/old",
        name: "xAI: Old",
        url: "https://x.ai/news/old",
        section: "news",
        path: "/news/old",
        maker: "xAI",
      },
    ],
  };
  const both = [signals, scouts];
  saveCollection(db, notes, both, "2026-09-18T00:00:00.000Z");
  saveCollection(db, pages, both, "2026-09-18T00:00:00.000Z");
  notes.records.push({
    id: "2026-09-17:grok-voice-transcribe-20",
    name: "Grok Voice Transcribe 2.0",
    url: "https://docs.x.ai/release-notes#grok-voice-transcribe-2",
    published: "2026-09-17T00:00:00.000Z",
  });
  saveCollection(db, notes, both, "2026-09-18T06:25:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-18T08:00:00.000Z"));
  db.exec("UPDATE deliveries SET status='sent', external_id='1'");
  pages.records.push({
    id: "/news/grok-voice-transcribe-2",
    name: "xAI: Grok voice transcribe 2",
    url: "https://x.ai/news/grok-voice-transcribe-2",
    section: "news",
    path: "/news/grok-voice-transcribe-2",
    maker: "xAI",
  });
  saveCollection(db, pages, both, "2026-09-18T18:33:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-18T20:00:00.000Z"));
  const rows = db
    .query<{ destination_id: string; status: string }, []>("SELECT destination_id, status FROM deliveries ORDER BY id")
    .all();
  const story = db
    .query<{ n: number }, []>(
      "SELECT COUNT(DISTINCT story_id) n FROM story_events se JOIN events e ON e.id=se.event_id WHERE e.entity_id LIKE '%voice-transcribe%'",
    )
    .get();
  expect(story?.n).toBe(1);
  expect(rows.filter((row) => row.destination_id === "scouts")).toEqual([]);
  expect(db.query("SELECT reason FROM suppressions WHERE destination_id='scouts'").all()).toContainEqual({
    reason: "announced_before_it_was_sighted",
  });
});
