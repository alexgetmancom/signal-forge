import { expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import {
  corroborationLine,
  corroborationOf,
  corroborationOfEvent,
  detectCorroborated,
} from "../src/events/corroboration.js";
import { passedOver } from "../src/reports/passedOver.js";
import { openDatabase } from "../src/storage/database.js";

const scouts = { id: "scouts", type: "discord", signals: ["codename"] } as unknown as Destination;
const now = Date.parse("2026-09-20T06:00:00.000Z");

/**
 * Step 5 Preview as it actually arrived: a leaderboard score, a gateway listing and a mirror
 * copying the listing, each one correctly judged too small for a card of its own.
 */
function setup() {
  const db = openDatabase(":memory:");
  db.exec("INSERT INTO snapshots(id,source,collected_at) VALUES(1,'x','2026-09-19T00:00:00.000Z')");
  db.exec(
    `INSERT INTO stories(id,stable_key,title,normalized_subject,vendor,first_seen_at,updated_at)
     VALUES(1,'stepfun:step-5-preview','Step 5 Preview','step 5 preview','StepFun',
            '2026-09-19T10:21:18.463Z','2026-09-20T05:31:00.165Z')`,
  );
  const add = (source: string, stream: string, authority: string, record: object, at: string) => {
    const id =
      db
        .query<{ id: number }, [string, string, string, string, string]>(
          `INSERT INTO events(source,stream,entity_id,kind,after_json,detected_at,snapshot_id,authority)
           VALUES(?,?,'step-5-preview','new',?,?,1,?) RETURNING id`,
        )
        .get(source, stream, JSON.stringify(record), at, authority)?.id ?? 0;
    db.query("INSERT INTO story_events(story_id,event_id) VALUES(1,?)").run(id);
    return id;
  };
  const board = add(
    "artificial-analysis",
    "leaderboards",
    "third_party",
    { name: "Step 5 Preview", rank: 41 },
    "2026-09-19T10:21:18.463Z",
  );
  const gateway = add(
    "vercel-gateway",
    "api-models",
    "third_party",
    { name: "Step 5 Preview" },
    "2026-09-20T04:59:34.136Z",
  );
  return { db, add, board, gateway };
}

test("two unrelated sources are not enough: the threshold is three", () => {
  const { db } = setup();
  expect(detectCorroborated(db, [scouts], now)).toEqual([]);
  expect(corroborationOf(db, 1)).toBeNull();
});

test("a third unrelated source cards a subject no reader has heard of", () => {
  const { db, add } = setup();
  const mirror = add("models-dev", "api-models", "third_party", { name: "Step 5 Preview" }, "2026-09-20T05:31:00.165Z");
  expect(detectCorroborated(db, [scouts], now)).toEqual([1]);

  // The card is rendered from the last event, which is the one that completed the count.
  expect(db.query("SELECT signal FROM batch_events WHERE event_id=?").get(mirror)).toEqual({ signal: "codename" });
  const corroboration = corroborationOfEvent(db, mirror);
  if (!corroboration) throw new Error("no corroboration stored");
  expect(corroboration.families).toEqual([
    "artificial-analysis",
    "provider-api:models-dev",
    "provider-api:vercel-gateway",
  ]);
  expect(corroborationLine(corroboration)).toBe("🔭 Step 5 Preview · recorded by 3 unrelated sources, never carded");
  // Once, and never again on the next pass.
  expect(detectCorroborated(db, [scouts], now)).toEqual([]);
});

test("a subject a reader was already told about is not carded again for agreeing with itself", () => {
  const { db, add, board } = setup();
  add("models-dev", "api-models", "third_party", { name: "Step 5 Preview" }, "2026-09-20T05:31:00.165Z");
  db.exec("INSERT INTO batches(id,source,digest,ready_at) VALUES(9,'x',0,'2026-09-19T11:00:00.000Z')");
  db.query("INSERT INTO batch_events(batch_id,event_id,url,signal) VALUES(9,?,'','codename')").run(board);
  db.exec(
    `INSERT INTO deliveries(batch_id,destination_id,destination_json,body,part,status,updated_at)
     VALUES(9,'scouts','{}','sent',0,'sent','2026-09-19T11:00:00.000Z')`,
  );
  expect(detectCorroborated(db, [scouts], now)).toEqual([]);
});

test("three surfaces of one vendor are one voice, not three sources", () => {
  const db = openDatabase(":memory:");
  db.exec("INSERT INTO snapshots(id,source,collected_at) VALUES(1,'x','2026-09-19T00:00:00.000Z')");
  db.exec(
    `INSERT INTO stories(id,stable_key,title,normalized_subject,vendor,first_seen_at,updated_at)
     VALUES(1,'acme:one','Acme One','acme one','Acme','2026-09-19T10:00:00.000Z','2026-09-20T05:00:00.000Z')`,
  );
  for (const source of ["acme-api", "acme-news", "acme-pages"]) {
    db.exec(`INSERT INTO sources(id,vendor,authority) VALUES('${source}','Acme','first_party')`);
    const id =
      db
        .query<{ id: number }, [string]>(
          `INSERT INTO events(source,stream,entity_id,kind,after_json,detected_at,snapshot_id,authority)
           VALUES(?,'api-models','acme-one','new','{"name":"Acme One"}','2026-09-20T05:00:00.000Z',1,'first_party')
           RETURNING id`,
        )
        .get(source)?.id ?? 0;
    db.query("INSERT INTO story_events(story_id,event_id) VALUES(1,?)").run(id);
  }
  expect(detectCorroborated(db, [scouts], now)).toEqual([]);
});

test("passed-over ranks the silent subjects by how much agreement they gathered", () => {
  const { db, add } = setup();
  add("models-dev", "api-models", "third_party", { name: "Step 5 Preview" }, "2026-09-20T05:31:00.165Z");
  const before = passedOver(db, 7);
  expect(before.threshold).toBe(3);
  expect(before.overThresholdAndSilent).toBe(1);
  const story = before.stories[0];
  expect(story?.title).toBe("Step 5 Preview");
  expect(story?.independentSourceCount).toBe(3);
  expect(story?.spoke).toBe(false);
  expect(story?.cardedByCorroboration).toBeNull();

  detectCorroborated(db, [scouts], now);
  // The subject is still silent until a delivery goes out, but the report now shows why it will not
  // stay that way: the rule has claimed it.
  expect(passedOver(db, 7).stories[0]?.cardedByCorroboration).toBe(3);
});

test("passed-over names the rules that kept a subject quiet", () => {
  const { db, add, board, gateway } = setup();
  add("models-dev", "api-models", "third_party", { name: "Step 5 Preview" }, "2026-09-20T05:31:00.165Z");
  db.exec("INSERT INTO batches(id,source,digest,ready_at) VALUES(9,'x',0,'2026-09-20T05:00:00.000Z')");
  for (const [event, reason] of [
    [board, "below_the_top_of_the_board"],
    [gateway, "trending_from_an_unfollowed_lab"],
  ] as const)
    db.query(
      `INSERT INTO suppressions(event_id,destination_id,batch_id,reason,detail,recorded_at)
       VALUES(?,'scouts',9,?,'','2026-09-20T05:00:00.000Z')`,
    ).run(event, reason);
  expect(passedOver(db, 7).stories[0]?.reasons).toEqual([
    { reason: "below_the_top_of_the_board", count: 1 },
    { reason: "trending_from_an_unfollowed_lab", count: 1 },
  ]);
});

test("three catalogues finishing the same import are not three organisations noticing a model", () => {
  const { db, add } = setup();
  // Grok 4.6 as it actually reached us: out since 12 August, sitting in our records since the
  // 17th, and a third registry finally listing it on the 20th. The count is theirs, not the
  // model's.
  db.query("UPDATE stories SET title='Grok 4.6 (high)', first_seen_at=? WHERE id=1").run("2026-09-17T04:36:45.967Z");
  add("models-dev", "api-models", "third_party", { name: "Grok 4.6" }, "2026-09-20T05:31:00.165Z");
  expect(detectCorroborated(db, [scouts], now)).toEqual([]);
  expect(corroborationOf(db, 1)).toBeNull();
});

test("a model the catalogue itself dates to August is not a discovery of this week", () => {
  const { db, add } = setup();
  add(
    "huggingface-router",
    "api-models",
    "third_party",
    { name: "Qwen/Qwen3.8-2.4T-A95B", created: "2026-08-08T01:50:52.000Z" },
    "2026-09-20T05:31:00.165Z",
  );
  expect(detectCorroborated(db, [scouts], now)).toEqual([]);
});

test("a catalogue rewriting its rows is no third source, and a model seen before the window is no discovery", () => {
  const { db, add } = setup();
  // OpenCode re-keying every row on 2026-09-22 arrived as changes, not as a model appearing.
  const rewrite = add(
    "opencode-zen",
    "api-models",
    "third_party",
    { name: "step-5-preview" },
    "2026-09-20T05:40:00.000Z",
  );
  db.query("UPDATE events SET kind='changed' WHERE id=?").run(rewrite);
  expect(detectCorroborated(db, [scouts], now)).toEqual([]);

  // A third arrival, but some source had it on 2026-09-10: gpt-5.4-mini's story restarted, the model did not.
  add("models-dev", "api-models", "third_party", { name: "Step 5 Preview" }, "2026-09-20T05:31:00.165Z");
  db.exec(
    "INSERT INTO events(source,stream,entity_id,kind,after_json,detected_at,snapshot_id,authority) VALUES('openrouter','openrouter','step-5-preview','new','{}','2026-09-10T00:00:00.000Z',1,'third_party')",
  );
  expect(detectCorroborated(db, [scouts], now)).toEqual([]);
});
