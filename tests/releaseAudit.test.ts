import { expect, test } from "bun:test";
import { releaseAudit } from "../src/reports/releaseAudit.js";
import { openDatabase } from "../src/storage/database.js";

test("a release is dated by its first source against its own timestamp, under whichever name it is listed", () => {
  const db = openDatabase(":memory:");
  db.query(
    "INSERT INTO snapshots(id,source,collected_at,body,hash,bytes) VALUES(1,'mimo','2026-09-21T19:45:00.000Z','{}','h',2)",
  ).run();
  const insert = db.query(
    "INSERT INTO events(source,stream,entity_id,kind,after_json,detected_at,snapshot_id) VALUES(?,'api-models',?,'new',?,?,1)",
  );
  insert.run(
    "mimo",
    "mimo-v2.6-pro",
    JSON.stringify({ id: "mimo-v2.6-pro", created: "2026-09-21T19:36:12.000Z" }),
    "2026-09-21T19:45:00.000Z",
  );
  insert.run(
    "openrouter",
    "xiaomi/mimo-v2.6-pro",
    JSON.stringify({ id: "xiaomi/mimo-v2.6-pro", created: "2026-09-21T00:00:00.000Z" }),
    "2026-09-21T20:19:00.000Z",
  );
  insert.run("groq", "lonely-model", JSON.stringify({ id: "lonely-model" }), "2026-09-21T20:00:00.000Z");

  const { releases } = releaseAudit(db, 7, Date.parse("2026-09-22T12:00:00.000Z"));
  expect(releases).toHaveLength(1);
  expect(releases[0]).toMatchObject({
    model: "mimo-v2.6-pro",
    firstSource: "mimo",
    upstreamAt: "2026-09-21T19:36:12.000Z",
    lagMinutes: 9,
    families: 2,
    cardAt: null,
  });
  db.close();
});
