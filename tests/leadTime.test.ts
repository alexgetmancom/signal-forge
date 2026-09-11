import { expect, test } from "bun:test";
import { type Collection, saveCollection } from "../src/events.js";
import { leadTime } from "../src/leadTime.js";
import { openDatabase } from "../src/storage/database.js";
import { listStories } from "../src/stories.js";

const catalogue = (source: string, stream: string, records: Collection["records"]): Collection => ({
  source,
  stream,
  url: "https://example.test",
  raw: records,
  records,
});

test("the source that saw a release first is the one credited with it", () => {
  const db = openDatabase(":memory:");
  const older = { id: "glm-4.6", name: "GLM-4.6" };
  const seed = [older, { id: "glm-5", name: "GLM-5" }];
  // Z.ai lists the model in its own catalogue two hours before OpenRouter resells it.
  saveCollection(db, catalogue("zai", "api-models", [older]), [], "2026-09-10T09:00:00.000Z");
  saveCollection(db, catalogue("zai", "api-models", seed), [], "2026-09-10T10:00:00.000Z");
  saveCollection(db, catalogue("openrouter", "openrouter", [older]), [], "2026-09-10T09:00:00.000Z");
  saveCollection(db, catalogue("openrouter", "openrouter", seed), [], "2026-09-10T12:00:00.000Z");
  // The correlation this report reads is built when stories are projected.
  expect(listStories(db, { limit: 10 })).toHaveLength(1);

  const report = leadTime(db, 3650);
  expect(report.stories).toBe(1);
  const zai = report.sources.find((row) => row.source === "zai");
  const openrouter = report.sources.find((row) => row.source === "openrouter");
  expect(zai).toMatchObject({ firstSightings: 1, appearances: 1, medianLeadHours: 2 });
  expect(openrouter).toMatchObject({ firstSightings: 0, appearances: 1, medianLagHours: 2 });
  db.close();
});

test("a source nobody corroborates still leads, without a measurable lead", () => {
  const db = openDatabase(":memory:");
  saveCollection(db, catalogue("arena", "arena", [{ id: "other", name: "other" }]), [], "2026-09-10T09:00:00.000Z");
  saveCollection(
    db,
    catalogue("arena", "arena", [
      { id: "other", name: "other" },
      { id: "zaatar", name: "zaatar" },
    ]),
    [],
    "2026-09-10T10:00:00.000Z",
  );
  listStories(db, { limit: 10 });

  const report = leadTime(db, 3650);
  expect(report.sources[0]).toMatchObject({ source: "arena", firstSightings: 1, medianLeadHours: null });
  db.close();
});
