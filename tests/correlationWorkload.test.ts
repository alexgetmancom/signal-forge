/**
 * A correlation workload with a frozen result and a budget on the work that produced it.
 *
 * The dataset is deliberately awkward: near-identical names for different models, the same model
 * seen again and again, history far outside the correlation window, independent sources confirming
 * one another, and the Hugging Face derivatives that correlate only with themselves. A dataset of
 * simple unique records would never reach the fallback scan at all, and would measure nothing.
 *
 * Two things are asserted, and the second is the reason the first is trustworthy: what merged with
 * what, and how much work the scan did to decide it. A faster projection that correlates
 * differently has to fail here, because that trade has already been made by accident once.
 */
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { saveCollection } from "../src/events/pipeline.js";
import type { Collection, RecordData } from "../src/events/types.js";
import { openDatabase } from "../src/storage/database.js";
import { listStories, rebuildStories, storyScanWork } from "../src/stories.js";

const DAY = 86_400_000;
const START = Date.parse("2026-01-01T00:00:00.000Z");

const at = (day: number, minute = 0): string => new Date(START + day * DAY + minute * 60_000).toISOString();

/** Counts statement executions, not `db.query` calls: the same prepared statement run once per
 * event is the shape an N+1 regression takes, and only execution counts see it. */
function countStatements(db: Database): () => number {
  let executions = 0;
  const original = db.query.bind(db);
  db.query = ((sql: string) => {
    const statement = original(sql) as unknown as Record<string, unknown>;
    return new Proxy(statement, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function" || !["get", "all", "run", "values"].includes(String(property))) return value;
        return (...args: unknown[]) => {
          executions += 1;
          return (value as (...rest: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  }) as unknown as typeof db.query;
  return () => executions;
}

const collection = (source: string, stream: string, records: RecordData[]): Collection => ({
  source,
  stream,
  url: "https://example.test/feed",
  raw: records,
  records,
});

/** Names that differ by one qualifier, which is exactly what the title similarity rule has to get
 * right: these are four different models, not one story seen four times. */
const FAMILY = ["gpt-6", "gpt-6-mini", "gpt-6-turbo", "gpt-6-vision"];

function build(db: Database): void {
  // Old history: far enough back that nothing recent may join it, but still walked by the scan.
  for (let round = 0; round < 6; round += 1)
    saveCollection(
      db,
      collection(
        "openrouter",
        "openrouter",
        FAMILY.map((id) => ({
          id: `openai/${id}`,
          name: id.toUpperCase(),
          maker: "OpenAI",
          url: `https://openrouter.ai/${id}`,
          pricing: { prompt: String(round) },
        })),
      ),
      [],
      at(round),
    );
  // Recent history, outside the window of the old rounds, repeated so the same subjects are seen
  // again rather than appearing once.
  for (let round = 0; round < 6; round += 1) {
    saveCollection(
      db,
      collection(
        "openrouter",
        "openrouter",
        FAMILY.map((id) => ({
          id: `openai/${id}`,
          name: id.toUpperCase(),
          maker: "OpenAI",
          url: `https://openrouter.ai/${id}`,
          pricing: { prompt: String(100 + round) },
        })),
      ),
      [],
      at(60 + round),
    );
    // An independent vendor source confirming the same subjects.
    saveCollection(
      db,
      collection(
        "openai",
        "api-models",
        FAMILY.map((id) => ({ id: `openai/${id}`, name: id.toUpperCase(), context: 100_000 + round })),
      ),
      [],
      at(60 + round, 30),
    );
    // Third-party derivatives carrying the base models' terms. These must never join the stories
    // above: seventy-three such matches in one week were all false.
    saveCollection(
      db,
      collection(
        "discovery:huggingface-trending",
        "discovery",
        FAMILY.map((id) => ({
          id: `someone/${id}-quantised-${round}`,
          name: `${id} quantised ${round}`,
          url: `https://huggingface.co/someone/${id}-q${round}`,
        })),
      ),
      [],
      at(60 + round, 45),
    );
  }
}

type Shape = { title: string; sources: string[]; events: number };

function shape(db: Database): Shape[] {
  return listStories(db, { limit: 200 }).map((story) => ({
    title: story.title,
    sources: [...story.sources].sort(),
    events: story.evidenceCoverage.eventCount,
  }));
}

const DERIVATIVE = "discovery:huggingface-trending";

/**
 * Exact, not "about this much". Every number here is a count of work the projection did on a fixed
 * dataset, so it is the same on any machine and repeats to the digit; a range would only hide the
 * drift it exists to catch. A change that moves one of these is a change in how much work
 * correlation costs, and updating the number is how that gets noticed and agreed to.
 */
const BUDGET = { scans: 32, comparisons: 388, statements: 202 };

test("the correlation workload groups the same evidence within its work budget", () => {
  const db = openDatabase(":memory:");
  build(db);

  storyScanWork.scans = 0;
  storyScanWork.comparisons = 0;
  const statements = countStatements(db);
  db.transaction(() => rebuildStories(db))();
  const work = { scans: storyScanWork.scans, comparisons: storyScanWork.comparisons, statements: statements() };

  const stories = shape(db);
  const derivatives = stories.filter((story) => story.sources.includes(DERIVATIVE));
  const correlated = stories.filter((story) => !story.sources.includes(DERIVATIVE));

  // Each of the four near-identically named models is its own pair of stories: the old history,
  // seen by one source, and the recent history, confirmed by two. Nothing merges across names.
  expect(correlated).toHaveLength(FAMILY.length * 2);
  for (const id of FAMILY) {
    const named = correlated.filter((story) => story.title === id.toUpperCase());
    expect(named.map((story) => ({ ...story, title: id }))).toEqual(
      expect.arrayContaining([
        { title: id, sources: ["openrouter"], events: 5 },
        { title: id, sources: ["openai", "openrouter"], events: 11 },
      ]),
    );
    expect(named).toHaveLength(2);
  }

  // Derivatives stay by themselves: never joined to a base model, never joined to each other.
  expect(derivatives).toHaveLength(24);
  for (const story of derivatives) expect(story.sources).toEqual([DERIVATIVE]);

  expect(work).toEqual(BUDGET);
});
