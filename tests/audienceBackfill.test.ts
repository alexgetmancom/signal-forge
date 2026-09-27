import { expect, test } from "bun:test";
import type { AppConfig } from "../src/config.js";
import { saveCollection } from "../src/events/pipeline.js";
import type { Collection } from "../src/events/types.js";
import { withAudience } from "../src/sources/audienceJudge.js";
import { openDatabase } from "../src/storage/database.js";

const config = { DEEPSEEK_API_KEY: "key" } as AppConfig;

/** One judge answer for every entry it is asked about, and a count of how often it was asked. */
function judge(verdict: "builders" | "consumers" | "silent") {
  const asked: string[][] = [];
  const request = async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages: { content: string }[] };
    const ids = [...String(body.messages[1]?.content ?? "").matchAll(/^ID: (.+)$/gm)].map((m) => m[1] as string);
    asked.push(ids);
    if (verdict === "silent") return new Response("nope", { status: 500 });
    const answer = Object.fromEntries(ids.map((id) => [id, verdict]));
    return Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }] });
  };
  return { asked, request: request as unknown as typeof fetch };
}

function note(records: { id: string; name: string; summary?: unknown; audience?: string }[]): Collection {
  return {
    source: "openai-chatgpt-release-notes",
    stream: "news",
    url: "https://help.openai.com/releases",
    authority: "vendor_owned",
    records,
    raw: JSON.stringify(records),
  } as unknown as Collection;
}

test("a record the judge failed on is asked about again, not treated as answered", async () => {
  const db = openDatabase(":memory:");
  const failing = judge("silent");
  const first = await withAudience(db, config, failing.request, "openai-chatgpt-release-notes", [
    { id: "a", name: "Note a", summary: "s" },
  ]);
  expect(first[0]?.audience).toBeUndefined();
  // Storing it without a verdict is what used to mark it handled for good.
  saveCollection(db, note(first), []);

  const answering = judge("builders");
  const second = await withAudience(db, config, answering.request, "openai-chatgpt-release-notes", [
    { id: "a", name: "Note a", summary: "s" },
  ]);
  expect(answering.asked[0]).toEqual(["a"]);
  expect(second[0]?.audience).toBe("builders");
  db.close();
});

test("a record already carrying a verdict is not paid for twice", async () => {
  const db = openDatabase(":memory:");
  const answering = judge("consumers");
  const first = await withAudience(db, config, answering.request, "openai-chatgpt-release-notes", [
    { id: "a", name: "Note a", summary: "s" },
  ]);
  saveCollection(db, note(first), []);

  const again = judge("builders");
  const second = await withAudience(db, config, again.request, "openai-chatgpt-release-notes", [
    { id: "a", name: "Note a", summary: "s" },
  ]);
  expect(again.asked).toHaveLength(0);
  expect(second[0]?.audience).toBe("consumers");
  db.close();
});

test("back-filling a verdict onto a stored record is not a change anybody hears about", async () => {
  const db = openDatabase(":memory:");
  const failing = judge("silent");
  const unjudged = await withAudience(db, config, failing.request, "openai-chatgpt-release-notes", [
    { id: "a", name: "Note a", summary: "s" },
  ]);
  // A baseline first, so the source is initialised and later polls can emit events at all.
  saveCollection(db, note(unjudged), []);
  saveCollection(db, note(unjudged), []);
  const before = db.query<{ c: number }, []>("SELECT COUNT(*) c FROM events").get()?.c ?? 0;

  const answering = judge("builders");
  const judged = await withAudience(db, config, answering.request, "openai-chatgpt-release-notes", [
    { id: "a", name: "Note a", summary: "s" },
  ]);
  expect(judged[0]?.audience).toBe("builders");
  saveCollection(db, note(judged), []);

  // The record now carries the verdict, and no reader was told the release note changed.
  const stored = db
    .query<{ body: string }, []>("SELECT body FROM records WHERE source='openai-chatgpt-release-notes'")
    .get();
  expect(JSON.parse(stored?.body ?? "{}").audience).toBe("builders");
  expect(db.query<{ c: number }, []>("SELECT COUNT(*) c FROM events").get()?.c).toBe(before);
  db.close();
});

test("a backlog of unjudged records is asked about in bounded batches", async () => {
  const db = openDatabase(":memory:");
  const records = Array.from({ length: 95 }, (_, index) => ({
    id: `n${index}`,
    name: `Note ${index}`,
    summary: "s",
  }));
  const answering = judge("builders");
  await withAudience(db, config, answering.request, "openai-chatgpt-release-notes", records);
  expect(answering.asked[0]).toHaveLength(12);
  db.close();
});

test("a judge that keeps answering unusably stops being paid to", async () => {
  const db = openDatabase(":memory:");
  const records = [{ id: "a", name: "Note a", summary: "s" }];
  const failing = judge("silent");
  for (let poll = 0; poll < 6; poll++)
    await withAudience(db, config, failing.request, "openai-chatgpt-release-notes", records);
  // Three unusable answers is enough to establish it; the rest of the polls cost nothing.
  expect(failing.asked).toHaveLength(3);
  expect(db.query<{ c: number }, []>("SELECT COUNT(*) c FROM deepseek_usage").get()?.c).toBe(3);
  db.close();
});

test("one usable answer ends the run, so a bad minute is not a lasting silence", async () => {
  const db = openDatabase(":memory:");
  const records = [{ id: "a", name: "Note a", summary: "s" }];
  const failing = judge("silent");
  await withAudience(db, config, failing.request, "openai-chatgpt-release-notes", records);
  await withAudience(db, config, failing.request, "openai-chatgpt-release-notes", records);

  const answering = judge("builders");
  expect(
    (await withAudience(db, config, answering.request, "openai-chatgpt-release-notes", records))[0]?.audience,
  ).toBe("builders");

  // The two failures before it are spent, not carried: the next two are asked as well.
  const again = judge("silent");
  await withAudience(db, config, again.request, "openai-chatgpt-release-notes", records);
  await withAudience(db, config, again.request, "openai-chatgpt-release-notes", records);
  expect(again.asked).toHaveLength(2);
  db.close();
});

test("the hold-off is per source: one broken judge does not silence the others", async () => {
  const db = openDatabase(":memory:");
  const records = [{ id: "a", name: "Note a", summary: "s" }];
  const failing = judge("silent");
  for (let poll = 0; poll < 5; poll++)
    await withAudience(db, config, failing.request, "openai-chatgpt-release-notes", records);
  expect(failing.asked).toHaveLength(3);

  const other = judge("builders");
  expect((await withAudience(db, config, other.request, "mistral-release-notes", records))[0]?.audience).toBe(
    "builders",
  );
  db.close();
});
