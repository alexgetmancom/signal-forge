import { expect, test } from "bun:test";
import { type Destination, loadConfig } from "../src/config.js";
import { type Collection, saveCollection } from "../src/events.js";
import { listHypotheses, rebuildHypotheses } from "../src/hypotheses.js";
import { listLifecycleDeadlines, rebuildLifecycleDeadlines, scheduleLifecycleReminders } from "../src/lifecycle.js";
import { getModelFacts, rebuildModelFacts } from "../src/modelFacts.js";
import { signalQuality } from "../src/signalQuality.js";
import { openDatabase } from "../src/storage/database.js";
import { rebuildStories } from "../src/stories.js";

const config = loadConfig({
  CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname,
  OPENAI_API_KEY: "openai-test-key",
  GITHUB_TOKEN: "github-test-key",
});
const destination: Destination = {
  id: "dc",
  platform: "discord",
  channelId: "123",
  streams: ["arena", "github", "openrouter", "api-models", "news", "deprecations"],
};

function collection(source: string, stream: Collection["stream"], records: Collection["records"]): Collection {
  return {
    source,
    stream,
    url: `https://example.test/${source}`,
    raw: records,
    appendOnly: true,
    records,
  };
}

function observe(
  db: ReturnType<typeof openDatabase>,
  source: string,
  stream: Collection["stream"],
  records: Collection["records"],
  at: string,
  destinations: Destination[],
): number {
  saveCollection(db, collection(source, stream, []), [], new Date(Date.parse(at) - 60_000).toISOString());
  saveCollection(db, collection(source, stream, records), destinations, at);
  return Number(db.query<{ id: number }, []>("SELECT MAX(id) AS id FROM events").get()?.id ?? 0);
}

test("early observations become a hypothesis, facts and lead-time evidence without synthetic events", () => {
  const db = openDatabase(":memory:");
  const arenaEvent = observe(
    db,
    "arena",
    "arena",
    [{ id: "model-x", name: "Model X", model: "model-x", maker: "OpenAI" }],
    "2026-09-10T09:12:00Z",
    [destination],
  );
  const githubEvent = observe(
    db,
    "discovery:github-ai",
    "github",
    [{ id: "openai/model-x", name: "openai/model-x", owner: "openai", description: "An AI model" }],
    "2026-09-10T09:26:00Z",
    [],
  );
  expect(listHypotheses(db)[0]).toMatchObject({ status: "emerging", independentSourceCount: 2 });
  const openRouterEvent = observe(
    db,
    "openrouter",
    "openrouter",
    [
      {
        id: "openai/model-x",
        name: "Model X",
        maker: "OpenAI",
        input: ["text"],
        output: ["text"],
        pricing: { prompt: "1" },
      },
    ],
    "2026-09-10T10:04:00Z",
    [destination],
  );
  expect(listHypotheses(db)[0]).toMatchObject({ status: "strengthening", independentSourceCount: 3 });
  const providerApiEvent = observe(
    db,
    "openai",
    "api-models",
    [{ id: "openai/model-x", name: "Model X", owner: "OpenAI", context: 128000 }],
    "2026-09-10T11:31:00Z",
    [destination],
  );
  const newsEvent = observe(
    db,
    "openai-news",
    "news",
    [{ id: "model-x-announcement", name: "Model X", maker: "OpenAI", summary: "Official announcement" }],
    "2026-09-10T12:02:00Z",
    [destination],
  );

  const hypothesis = listHypotheses(db)[0];
  expect(hypothesis).toMatchObject({ status: "confirmed", resolutionEventId: providerApiEvent });
  expect(hypothesis?.events.map((event) => event.eventId)).toEqual([
    arenaEvent,
    githubEvent,
    openRouterEvent,
    providerApiEvent,
  ]);
  expect(hypothesis?.events.find((event) => event.eventId === providerApiEvent)?.role).toBe("resolution");

  const facts = getModelFacts(db, "openai/model-x");
  expect(facts).toMatchObject({ canonicalId: "openai/model-x" });
  expect(facts?.facts.contextWindow).toMatchObject({
    value: 128000,
    source: "openai",
    eventId: providerApiEvent,
    confidence: "confirmed",
    evidenceType: "api_catalogue",
    observedAt: "2026-09-10T11:31:00Z",
  });
  expect(facts?.facts.availableOnOpenRouter).toMatchObject({
    value: true,
    source: "openrouter",
    eventId: openRouterEvent,
  });
  expect(facts?.facts.availableInProviderApi).toMatchObject({
    value: true,
    source: "openai",
    eventId: providerApiEvent,
  });
  expect(facts?.facts.inputModalities).toMatchObject({ value: ["text"], eventId: openRouterEvent });
  expect(facts?.facts.outputModalities).toMatchObject({ value: ["text"], eventId: openRouterEvent });

  expect(db.query("SELECT id FROM events ORDER BY id").all()).toEqual(
    [arenaEvent, githubEvent, openRouterEvent, providerApiEvent, newsEvent].map((id) => ({ id })),
  );
  expect(db.query("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 5 });
  expect(db.query("SELECT COUNT(*) AS count FROM batches WHERE source='discovery:github-ai'").get()).toEqual({
    count: 0,
  });
  expect(db.query("SELECT COUNT(*) AS count FROM deliveries").get()).toEqual({ count: 4 });

  const quality = signalQuality(db, config, 7, Date.parse("2026-09-10T13:00:00Z"));
  expect(quality.sources.find((source) => source.id === "arena")).toMatchObject({
    firstSourceWins: 1,
    laterConfirmed: 1,
    medianLeadTimeSeconds: 8340,
  });
  expect(quality.sources.find((source) => source.id === "discovery:github-ai")).toMatchObject({
    mode: "shadow",
    firstSourceWins: 0,
  });

  const before = {
    stories: db.query("SELECT * FROM stories ORDER BY id").all(),
    facts: db.query("SELECT * FROM model_fact_fields ORDER BY canonical_id,field").all(),
    hypotheses: db.query("SELECT * FROM hypotheses ORDER BY id").all(),
    hypothesisEvents: db.query("SELECT * FROM hypothesis_events ORDER BY hypothesis_id,event_id").all(),
  };
  const rebuild = () => {
    db.transaction(() => {
      rebuildStories(db);
      rebuildModelFacts(db);
      rebuildHypotheses(db, Date.parse("2026-09-10T13:00:00Z"));
      rebuildLifecycleDeadlines(db, Date.parse("2026-09-10T13:00:00Z"));
    })();
  };
  const eventCount = db.query("SELECT COUNT(*) AS count FROM events").get();
  const batchCount = db.query("SELECT COUNT(*) AS count FROM batches").get();
  rebuild();
  expect({
    stories: db.query("SELECT * FROM stories ORDER BY id").all(),
    facts: db.query("SELECT * FROM model_fact_fields ORDER BY canonical_id,field").all(),
    hypotheses: db.query("SELECT * FROM hypotheses ORDER BY id").all(),
    hypothesisEvents: db.query("SELECT * FROM hypothesis_events ORDER BY hypothesis_id,event_id").all(),
  }).toEqual(before);
  expect(db.query("SELECT COUNT(*) AS count FROM events").get()).toEqual(eventCount);
  expect(db.query("SELECT COUNT(*) AS count FROM batches").get()).toEqual(batchCount);

  const lifecycleEvent = observe(
    db,
    "anthropic-deprecations",
    "deprecations",
    [
      {
        id: "claude-example",
        name: "Claude example",
        maker: "Anthropic",
        stage: "Deprecated",
        deprecated: null,
        retirement: "2026-10-14",
        url: "https://platform.claude.com/docs/en/about-claude/model-deprecations",
      },
    ],
    "2026-09-10T12:30:00Z",
    [destination],
  );
  expect(lifecycleEvent).toBe(6);
  expect(listLifecycleDeadlines(db, 365, Date.parse("2026-09-10T13:00:00Z"))).toHaveLength(1);
  const deliveriesBeforeReminder = db
    .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM deliveries")
    .get()?.count;
  expect(
    scheduleLifecycleReminders(db, { ...config, destinations: [destination] }, Date.parse("2026-09-14T00:00:00Z")),
  ).toBe(1);
  expect(
    scheduleLifecycleReminders(db, { ...config, destinations: [destination] }, Date.parse("2026-09-14T00:00:00Z")),
  ).toBe(0);
  expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM deliveries").get()?.count).toBe(
    (deliveriesBeforeReminder ?? 0) + 1,
  );
  rebuild();
  expect(
    scheduleLifecycleReminders(db, { ...config, destinations: [destination] }, Date.parse("2026-09-14T00:00:00Z")),
  ).toBe(0);
  expect(db.query("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 6 });
  expect(db.query("SELECT COUNT(*) AS count FROM batches WHERE kind='lifecycle_reminder'").get()).toEqual({ count: 1 });
  db.close();
});
