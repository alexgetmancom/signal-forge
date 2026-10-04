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
import { aSource } from "./fixtures/build.js";

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

test("OpenRouter's catalogue and its usage board are one organisation, not two", () => {
  const db = openDatabase(":memory:");
  db.exec("INSERT INTO snapshots(id,source,collected_at) VALUES(1,'x','2026-10-01T00:00:00.000Z')");
  db.exec(
    `INSERT INTO stories(id,stable_key,title,normalized_subject,vendor,first_seen_at,updated_at)
     VALUES(1,'unbiased:pareto-26.10-preview','unbiased/pareto-26.10-preview-20260929',
            'unbiased pareto 26 10 preview 20260929','Unknown',
            '2026-10-01T14:11:59.972Z','2026-10-04T04:20:31.266Z')`,
  );
  const add = (source: string, stream: string, at: string) => {
    const id =
      db
        .query<{ id: number }, [string, string, string]>(
          `INSERT INTO events(source,stream,entity_id,kind,after_json,detected_at,snapshot_id,authority)
           VALUES(?,?,'unbiased/pareto-26.10-preview-20260929','new','{"name":"unbiased/pareto-26.10-preview-20260929"}',?,1,'third_party')
           RETURNING id`,
        )
        .get(source, stream, at)?.id ?? 0;
    db.query("INSERT INTO story_events(story_id,event_id) VALUES(1,?)").run(id);
  };
  add("openrouter", "openrouter", "2026-10-01T14:11:59.972Z");
  add("models-dev", "api-models", "2026-10-01T14:38:27.626Z");
  add("openrouter-usage", "leaderboards", "2026-10-04T04:20:31.266Z");

  // Three source ids, two organisations. The board arriving three days later is OpenRouter
  // repeating itself, and it carded this model and apodex/apodex-1.1-mini on 2026-10-04.
  expect(detectCorroborated(db, [scouts], Date.parse("2026-10-04T04:24:51.449Z"))).toEqual([]);
  expect(corroborationOf(db, 1)).toBeNull();
  db.close();
});

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
  const before = passedOver(db, 7, 50, now);
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
  expect(passedOver(db, 7, 50, now).stories[0]?.cardedByCorroboration).toBe(3);
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
  expect(passedOver(db, 7, 50, now).stories[0]?.reasons).toEqual([
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

test("a catalogue rewriting rows it already had is not a miss the report should headline", () => {
  const { db, add } = setup();
  add("models-dev", "api-models", "third_party", { name: "Gemini 3.8 Flash" }, "2026-09-20T05:31:00.165Z");
  // Gemini 3.8 Flash on 2026-09-27: three families, every one of them a `changed`, for a model
  // Google had shipped on 2 September. The rule counts arrivals and saw nothing here, so a
  // headline that counted the wider number was reporting a miss the rule never had.
  db.query("UPDATE stories SET title='Gemini 3.8 Flash' WHERE id=1").run();
  db.exec("UPDATE events SET kind='changed' WHERE id IN (SELECT event_id FROM story_events WHERE story_id=1)");

  const report = passedOver(db, 7, 50, now);
  const story = report.stories[0];
  expect(story?.independentSourceCount).toBe(3);
  expect(story?.arrivalSourceCount).toBe(0);
  expect(report.overThresholdAndSilent).toBe(0);
  expect(detectCorroborated(db, [scouts], now)).toEqual([]);
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

test("a subject the catalogue dates to weeks before we met it is late, not missed", () => {
  const { db, add } = setup();
  // Gemini 3.8 Flash: Google shipped it on 2 September and our first sighting was on the 19th.
  // Three sources, never carded, and not a miss -- nobody was still waiting to be told.
  db.query("UPDATE stories SET title='Gemini 3.8 Flash' WHERE id=1").run();
  add(
    "models-dev",
    "api-models",
    "third_party",
    { name: "Gemini 3.8 Flash", created: "2026-09-02T00:00:00.000Z" },
    "2026-09-20T05:31:00.165Z",
  );
  db.query("UPDATE stories SET released_at='2026-09-02T00:00:00.000Z' WHERE id=1").run();

  const report = passedOver(db, 7, 50, now);
  const story = report.stories[0];
  expect(story?.releasedAt).toBe("2026-09-02T00:00:00.000Z");
  expect(story?.lateByDays).toBe(17);
  expect(report.lateAndSilent).toBe(0);
});

test("a release date nobody claimed is no claim, not a fresh release", () => {
  const { db } = setup();
  const story = passedOver(db, 7, 50, now).stories[0];
  expect(story?.releasedAt).toBeNull();
  expect(story?.lateByDays).toBeNull();
  expect(passedOver(db, 7, 50, now).lateAndSilent).toBe(0);
});

/** Since when each of the subject's sources has been read, which is when a miss becomes ours. */
function watching(db: ReturnType<typeof openDatabase>, since: string): void {
  for (const source of ["artificial-analysis", "vercel-gateway", "models-dev"])
    aSource(db, source, { firstObservedAt: since });
}

test("a model released before we read any of its sources is an import of history, not a miss", () => {
  const { db, add } = setup();
  // DeepSeek V3 as it actually arrived: released in February 2024, handed to us by the OpenRouter
  // catalogue on the first call we ever made to it. 623 days "late" by the release alone, and
  // nobody could have carried it sooner, because we were not there.
  add(
    "models-dev",
    "api-models",
    "third_party",
    { name: "DeepSeek V3", created: "2024-02-04T00:00:00.000Z" },
    "2026-09-20T05:31:00.165Z",
  );
  db.query("UPDATE stories SET title='DeepSeek V3',released_at='2024-02-04T00:00:00.000Z' WHERE id=1").run();
  watching(db, "2026-09-18T00:00:00.000Z");

  const report = passedOver(db, 7, 50, now);
  const story = report.stories[0];
  expect(story?.lateByDays).toBe(958);
  expect(story?.watchedSince).toBe("2026-09-18T00:00:00.000Z");
  expect(story?.historyImport).toBe(true);
  // One day from the day we began reading it to the day we saw it, which is the honest number.
  expect(story?.lateAfterWatchingDays).toBe(1);
  expect(report.lateAndSilent).toBe(0);
  expect(report.historyImportsAndSilent).toBe(1);
  db.close();
});

test("lateness is counted from the day we began reading a source that could have carried it", () => {
  const { db, add } = setup();
  add(
    "models-dev",
    "api-models",
    "third_party",
    { name: "Step 5 Preview", created: "2026-08-01T00:00:00.000Z" },
    "2026-09-20T05:31:00.165Z",
  );
  db.query("UPDATE stories SET released_at='2026-08-01T00:00:00.000Z' WHERE id=1").run();
  // Reading these sources since July: the model came out under our noses and we met it seven weeks on.
  watching(db, "2026-07-01T00:00:00.000Z");

  const report = passedOver(db, 7, 50, now);
  expect(report.stories[0]?.historyImport).toBe(false);
  expect(report.stories[0]?.lateAfterWatchingDays).toBe(49);
  expect(report.lateAndSilent).toBe(1);
  expect(report.historyImportsAndSilent).toBe(0);
  db.close();
});

test("a source with no collection on record dates nothing, and the release date stands alone", () => {
  const { db } = setup();
  db.query("UPDATE stories SET released_at='2024-02-04T00:00:00.000Z' WHERE id=1").run();
  const story = passedOver(db, 7, 50, now).stories[0];
  expect(story?.watchedSince).toBeNull();
  expect(story?.historyImport).toBe(false);
  expect(story?.lateAfterWatchingDays).toBeNull();
  expect(story?.lateByDays).toBe(958);
  db.close();
});
