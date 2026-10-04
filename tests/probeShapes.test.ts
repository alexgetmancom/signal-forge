import { expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import { prepareDeliveries } from "../src/events/batching.js";
import { saveCollection } from "../src/events/pipeline.js";
import { isTheFirstReadOfAShape, probeMemory, SHAPE_BACKFILL_MS } from "../src/sources/probeMemory.js";
import { collectDocsProbe, PROBE_SITES } from "../src/sources/probes.js";
import { openDatabase } from "../src/storage/database.js";
import { storeSnapshot } from "../src/storage/snapshots.js";

const anthropic = PROBE_SITES.find((site) => site.id === "discovery:docs-anthropic");

/** A catalogue holding the ids named, which is what the probe reads its shapes out of. */
function catalogue(ids: readonly string[]) {
  const db = openDatabase(":memory:");
  const insert = db.query(
    "INSERT INTO model_facts(canonical_id,first_seen_at,updated_at) VALUES(?,'2026-09-22T00:00:00.000Z','2026-09-22T00:00:00.000Z')",
  );
  for (const id of ids) insert.run(id);
  return db;
}

/**
 * Every address this maker could have answers, which is what reading a back catalogue looks like.
 * The impossible version still 404s, or the negative control fails the poll before any guess.
 */
const everything = (async (input: string | URL) =>
  new Response("a page", {
    status: String(input).includes("/models/") && !String(input).includes("-99-99") ? 200 : 404,
  })) as unknown as typeof fetch;

test("the poll that first asks about a shape dates it, and a later poll leaves the date alone", async () => {
  if (!anthropic) throw new Error("the Anthropic probe is gone");
  const db = catalogue(["claude-opus-5-5"]);
  const first = Date.parse("2026-09-30T14:45:12.000Z");
  const opening = await collectDocsProbe(db, anthropic, everything, first);
  storeSnapshot(db, opening.source, new Date(first).toISOString(), JSON.stringify(opening.raw));
  expect((opening.raw as { shapes: Record<string, string> }).shapes.opus).toBe(new Date(first).toISOString());

  // The maker's other lines enter the catalogue, so the probe starts asking about them too.
  for (const id of ["claude-fable-5-1", "claude-mythos-5-1"])
    db.query(
      "INSERT INTO model_facts(canonical_id,first_seen_at,updated_at) VALUES(?,'2026-09-30T00:00:00.000Z','2026-09-30T00:00:00.000Z')",
    ).run(id);
  const later = first + 300_000;
  const widened = await collectDocsProbe(db, anthropic, everything, later);
  const { shapes } = widened.raw as { shapes: Record<string, string> };
  // Opus keeps the date it was first asked about; the two new lines are dated to this poll.
  expect(shapes.opus).toBe(new Date(first).toISOString());
  expect(shapes.fable).toBe(new Date(later).toISOString());
  expect(shapes.mythos).toBe(new Date(later).toISOString());
  db.close();
});

test("everything a newly asked shape answers for is an import of history; the line already asked is not", async () => {
  if (!anthropic) throw new Error("the Anthropic probe is gone");
  const db = catalogue(["claude-opus-5-5", "claude-fable-5-1"]);
  const at = Date.parse("2026-09-30T14:45:12.000Z");
  const collection = await collectDocsProbe(db, anthropic, everything, at);
  storeSnapshot(db, collection.source, new Date(at).toISOString(), JSON.stringify(collection.raw));
  const found = collection.records.map((record) => String(record.id));
  expect(found).toContain("fable-6");
  const stamp = new Date(at + 1000).toISOString();
  for (const slug of found) expect(isTheFirstReadOfAShape(db, collection.source, slug, stamp)).toBe(true);
  // An hour on, the same shape's pages are the maker publishing rather than us catching up.
  const afterwards = new Date(at + SHAPE_BACKFILL_MS + 1).toISOString();
  expect(isTheFirstReadOfAShape(db, collection.source, "fable-6", afterwards)).toBe(false);
  // A name nothing asked about under a shape -- a heard name, a crossed codename -- is never held.
  expect(isTheFirstReadOfAShape(db, collection.source, "fable-7-nova", stamp)).toBe(false);
  // And the question belongs to probes alone: no other source dates the shapes it asks about.
  expect(isTheFirstReadOfAShape(db, "models-dev", "fable-6", stamp)).toBe(false);
  db.close();
});

test("a snapshot written before shapes were dated reads as shapes asked about long ago", () => {
  const db = openDatabase(":memory:");
  storeSnapshot(
    db,
    "discovery:docs-anthropic",
    "2026-09-29T00:00:00.000Z",
    JSON.stringify({ "opus-6": { status: 404, at: "2026-09-29T00:00:00.000Z", family: "opus" } }),
  );
  const { asked, shapes } = probeMemory(db, "discovery:docs-anthropic");
  expect(asked["opus-6"]?.status).toBe(404);
  expect(shapes.opus).toBe("1970-01-01T00:00:00.000Z");
  // So the first poll after this ships holds nothing: the shape was not new, only the record of it.
  expect(isTheFirstReadOfAShape(db, "discovery:docs-anthropic", "opus-6", "2026-09-30T00:00:00.000Z")).toBe(false);
  db.close();
});

const wire: Destination = {
  id: "scouts",
  platform: "discord",
  channelId: "1",
  signals: ["launch", "codename", "rank", "change", "evidence", "release", "article", "feature", "research"],
};

test("the names a widened probe finds on its first pass are held back from the channel", async () => {
  if (!anthropic) throw new Error("the Anthropic probe is gone");
  const db = catalogue(["claude-opus-5-5"]);
  // The probe has been running on one line for a while, so a later poll is a difference and not a
  // baseline: a source's first collection produces no events at all.
  const before = "2026-09-30T14:40:00.000Z";
  saveCollection(db, await collectDocsProbe(db, anthropic, everything, Date.parse(before)), [wire], before);
  // The maker's other line enters the catalogue, and the probe asks about it for the first time.
  db.query(
    "INSERT INTO model_facts(canonical_id,first_seen_at,updated_at) VALUES('claude-fable-5-1','2026-09-30T00:00:00.000Z','2026-09-30T00:00:00.000Z')",
  ).run();
  const at = "2026-09-30T14:45:12.000Z";
  saveCollection(db, await collectDocsProbe(db, anthropic, everything, Date.parse(at)), [wire], at);
  prepareDeliveries(db, Date.parse("2026-09-30T14:50:00.000Z"));
  const verdicts = db
    .query<{ entity_id: string; reason: string | null }, []>(
      `SELECT e.entity_id, (SELECT s.reason FROM suppressions s WHERE s.event_id=e.id) AS reason
         FROM events e WHERE e.kind='new'`,
    )
    .all();
  const reasons = Object.fromEntries(verdicts.map((row) => [row.entity_id, row.reason]));
  // Every page the newly asked line answers for is its back catalogue, not this afternoon's news.
  expect(reasons["fable-6"]).toBe("the_first_read_of_a_new_shape");
  // Every one of them, and nothing else arrived: the line already asked about was recorded by the
  // poll before, so what this poll found is the widening and all of it is held.
  expect(Object.values(reasons)).toEqual(Object.values(reasons).map(() => "the_first_read_of_a_new_shape"));
  expect(Object.keys(reasons).every((slug) => slug.startsWith("fable-"))).toBe(true);
  db.close();
});
