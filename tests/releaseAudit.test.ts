import { expect, test } from "bun:test";
import { releaseAudit } from "../src/reports/releaseAudit.js";
import { openDatabase } from "../src/storage/database.js";

test("a release is dated by its first source against its own timestamp, under whichever name it is listed", () => {
  const db = openDatabase(":memory:");
  db.query(
    "INSERT INTO snapshots(id,source,collected_at,body,hash,bytes) VALUES(1,'mimo','2026-09-21T19:45:00.000Z','{}','h',2)",
  ).run();
  const insert = db.query(
    "INSERT INTO events(source,stream,entity_id,kind,after_json,detected_at,snapshot_id,authority) VALUES(?,'api-models',?,'new',?,?,1,?)",
  );
  insert.run(
    "mimo",
    "mimo-v2.6-pro",
    JSON.stringify({ id: "mimo-v2.6-pro", created: "2026-09-21T19:36:12.000Z" }),
    "2026-09-21T19:45:00.000Z",
    "first_party",
  );
  insert.run(
    "openrouter",
    "xiaomi/mimo-v2.6-pro",
    JSON.stringify({ id: "xiaomi/mimo-v2.6-pro", created: "2026-09-21T00:00:00.000Z" }),
    "2026-09-21T20:19:00.000Z",
    "third_party",
  );
  insert.run("groq", "lonely-model", JSON.stringify({ id: "lonely-model" }), "2026-09-21T20:00:00.000Z", "third_party");
  // OpenRouter's own date for a model is when it set the model up, not when the maker released it.
  insert.run(
    "openrouter",
    "acme/gemini-3.8-live",
    JSON.stringify({ id: "acme/gemini-3.8-live", created: "2026-09-10T12:34:56.000Z" }),
    "2026-09-21T17:29:00.000Z",
    "third_party",
  );
  insert.run(
    "pages:google",
    "/gemini-api/docs/models/gemini-3.8-live",
    "{}",
    "2026-09-21T18:05:00.000Z",
    "first_party",
  );

  const { releases } = releaseAudit(db, 7, Date.parse("2026-09-22T12:00:00.000Z"));
  expect(releases).toHaveLength(2);
  expect(releases.find((release) => release.model === "gemini-3.8-live")).toMatchObject({
    firstSource: "openrouter",
    upstreamAt: null,
    families: 2,
  });
  expect(releases.find((release) => release.model === "mimo-v2.6-pro")).toMatchObject({
    model: "mimo-v2.6-pro",
    firstSource: "mimo",
    upstreamAt: "2026-09-21T19:36:12.000Z",
    lagMinutes: 9,
    families: 2,
    cardAt: null,
  });
  db.close();
});
