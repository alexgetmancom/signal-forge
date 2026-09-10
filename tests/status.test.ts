import { expect, test } from "bun:test";
import { publishAlerts, recoverInterruptedAlerts } from "../src/alerts.js";
import { loadConfig } from "../src/config.js";
import { saveCollection } from "../src/events.js";
import { PLATFORMS, parsePlatformStatus } from "../src/sources/platforms.js";
import { activityEmbed, platformEmbed, publishStatus, sourceHealth, statusEmbed } from "../src/status.js";
import { openDatabase } from "../src/storage/database.js";

const config = loadConfig({
  CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname,
  TELEGRAM_BOT_TOKEN: "fake-telegram",
  DISCORD_BOT_TOKEN: "fake-discord",
  GEMINI_API_KEY: "fake-gemini",
});
const withStatus = { ...config, statusChannelId: "99" };
const now = Date.parse("2026-09-08T12:00:00.000Z");

function seed(db: ReturnType<typeof openDatabase>, id: string, row: Record<string, string | null>): void {
  db.query("INSERT INTO sources(id,last_success,last_error,checked_at) VALUES(?,?,?,?)").run(
    id,
    row.last_success ?? null,
    row.last_error ?? null,
    row.checked_at ?? null,
  );
}

test("a restricted source is reported apart from a broken one", () => {
  const db = openDatabase(":memory:");
  const recent = new Date(now - 60_000).toISOString();
  seed(db, "gemini", { last_error: "Source returned HTTP 400", checked_at: recent });
  seed(db, "openrouter", { last_error: "Source returned HTTP 500", checked_at: recent });

  const health = sourceHealth(db, withStatus, now);
  expect(health.find((entry) => entry.id === "gemini")?.state).toBe("blocked");
  expect(health.find((entry) => entry.id === "openrouter")?.state).toBe("failing");
  db.close();
});

test("a rate-limited source waits on upstream instead of reporting a broken collector", () => {
  const db = openDatabase(":memory:");
  const recent = new Date(now - 60_000).toISOString();
  seed(db, "huggingface:openai", { last_error: "Source returned HTTP 429", checked_at: recent });
  const health = sourceHealth(db, withStatus, now).find((entry) => entry.id === "huggingface:openai");
  expect(health).toMatchObject({ state: "blocked", detail: "rate limited — backing off" });
  db.close();
});

test("bot protection is blocked upstream, not reported as a broken parser", () => {
  const db = openDatabase(":memory:");
  const recent = new Date(now - 60_000).toISOString();
  seed(db, "status:anthropic", { last_error: "Source challenged by bot protection", checked_at: recent });
  expect(sourceHealth(db, withStatus, now).find((entry) => entry.id === "status:anthropic")).toMatchObject({
    state: "blocked",
    detail: "upstream bot protection — waiting for a readable status response",
  });
  db.close();
});

test("multi-source hosts have one shared request pace", async () => {
  const { sourceJobs } = await import("../src/sources/registry.js");
  const db = openDatabase(":memory:");
  const jobs = sourceJobs(db, config);
  for (const prefix of ["huggingface:", "designarena:"]) {
    const paced = jobs.filter((job) => job.id.startsWith(prefix)).map((job) => job.pace);
    expect(paced.length).toBeGreaterThan(1);
    expect(new Set(paced.map((pace) => pace?.group)).size).toBe(1);
    expect(paced.every((pace) => pace?.seconds === 60)).toBe(true);
  }
  db.close();
});

test("a source that missed three of its own intervals is stale, not failing", () => {
  const db = openDatabase(":memory:");
  const old = new Date(now - 4 * 300 * 1000).toISOString();
  seed(db, "openrouter", { last_success: old, checked_at: old });
  expect(sourceHealth(db, withStatus, now).find((entry) => entry.id === "openrouter")?.state).toBe("stale");
  db.close();
});

test("a suspicious collection shrink is visible as degraded", () => {
  const db = openDatabase(":memory:");
  db.query("INSERT INTO sources(id,last_error,last_success,checked_at) VALUES('openrouter',?,?,?)").run(
    "Collection degraded: openrouter retained 4 of 10 records",
    "2026-09-08T11:00:00.000Z",
    "2026-09-08T12:00:00.000Z",
  );
  const health = sourceHealth(db, withStatus, Date.parse("2026-09-08T12:00:00.000Z"));
  expect(health.find((entry) => entry.id === "openrouter")).toMatchObject({
    state: "degraded",
    lastSuccess: "2026-09-08T11:00:00.000Z",
  });
  db.close();
});

test("the board posts once and edits afterwards", async () => {
  const db = openDatabase(":memory:");
  seed(db, "openrouter", { last_success: new Date(now - 1000).toISOString(), checked_at: new Date(now).toISOString() });

  const calls: string[] = [];
  const request = async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url).split("/channels/")[1]}`);
    return new Response(JSON.stringify({ id: "555" }), { status: 200 });
  };
  expect(await publishStatus(db, withStatus, request, now)).toBe("created");
  // Nothing moved, so the board is not rewritten: an unchanged status is not an event.
  expect(await publishStatus(db, withStatus, request, now)).toBe("unchanged");

  seed(db, "arena", { last_error: "Source returned HTTP 500", checked_at: new Date(now).toISOString() });
  expect(await publishStatus(db, withStatus, request, now)).toBe("edited");
  // The unchanged cycle still checks the board is there: a board deleted by hand must come back.
  expect(calls).toEqual(["POST 99/messages", "GET 99/messages/555", "PATCH 99/messages/555"]);
  db.close();
});

test("a board deleted by hand is posted again even though its content did not change", async () => {
  const db = openDatabase(":memory:");
  seed(db, "openrouter", { last_success: new Date(now - 1000).toISOString(), checked_at: new Date(now).toISOString() });
  let deleted = false;
  const request = async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (deleted && method !== "POST") return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ id: "555" }), { status: 200 });
  };
  expect(await publishStatus(db, withStatus, request, now)).toBe("created");
  deleted = true;
  // This is how the boards are put in the right order: delete one, and the next cycle reposts it.
  expect(await publishStatus(db, withStatus, request, now)).toBe("created");
  db.close();
});

test("the embed groups sources and colours by the worst state", () => {
  const db = openDatabase(":memory:");
  seed(db, "openrouter", { last_error: "Source returned HTTP 500", checked_at: new Date(now).toISOString() });
  const embed = statusEmbed(sourceHealth(db, withStatus, now), now);
  expect(embed.color).toBe(0xe74c3c);
  expect((embed.fields as { name: string }[]).map((field) => field.name)).toContain("Catalogues");
  db.close();
});

test("public tracker status includes observation freshness without operator details", () => {
  const db = openDatabase(":memory:");
  const checked = new Date(now).toISOString();
  seed(db, "openrouter", { last_success: checked, checked_at: checked });
  const embed = statusEmbed(sourceHealth(db, withStatus, now), now);
  const fields = embed.fields as { name: string; value: string }[];
  expect(fields.find((field) => field.name === "Catalogues")?.value).toContain("2026-09-08 12:00 UTC");
  expect(fields.some((field) => field.name === "Delivery")).toBe(false);
  expect(fields.some((field) => field.name === "Integrations")).toBe(false);
  db.close();
});

test("activity status links the latest source and labels its counts as observations", () => {
  const db = openDatabase(":memory:");
  const destination = {
    id: "models",
    platform: "discord" as const,
    channelId: "123",
    streams: ["openrouter" as const],
  };
  const collection = {
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai/models",
    raw: [],
    records: [{ id: "base", name: "Base model" }],
  };
  saveCollection(db, collection, [destination], "2026-09-08T11:00:00.000Z");
  collection.records.push({ id: "gpt-6", name: "GPT-6" });
  saveCollection(db, collection, [destination], "2026-09-08T11:30:00.000Z");

  const embed = activityEmbed(db, now) as { description: string; footer: { text: string }; url: string };
  expect(embed.description).toContain("Latest: **GPT-6** · [open source](https://openrouter.ai/models)");
  expect(embed.description).not.toContain("#");
  expect(embed.url).toBe("https://openrouter.ai/models");
  expect(embed.footer.text).toContain("Observed event counts");
  db.close();
});

test("tracker status keeps disabled and missing sources out of the public detail list", () => {
  const db = openDatabase(":memory:");
  const config = {
    ...withStatus,
    sourceEnabled: { ...withStatus.sourceEnabled, openai: false },
  };
  const health = sourceHealth(db, config, now);
  expect(health.find((entry) => entry.id === "openai")).toMatchObject({
    state: "disabled",
    detail: "disabled by configuration",
  });
  expect(health.find((entry) => entry.id === "anthropic")).toMatchObject({
    state: "missing",
    detail: "missing ANTHROPIC_API_KEY",
  });

  const embed = statusEmbed(health, now);
  const fields = embed.fields as { name: string; value: string }[];
  const sourceText = fields.map((field) => field.value).join("\n");
  for (const entry of health.filter((source) => source.state !== "missing" && source.state !== "disabled"))
    expect(sourceText).toContain(entry.label);
  expect(embed.description).toContain("sources outside current coverage");
  expect(sourceText).not.toContain("ANTHROPIC_API_KEY");
  expect(fields.some((field) => field.name === "Open weights")).toBe(true);
  db.close();
});

test("source status exposes shadow mode without changing collector health", () => {
  const db = openDatabase(":memory:");
  const config = { ...withStatus, sourceMode: { ...withStatus.sourceMode, openrouter: "shadow" as const } };
  const entry = sourceHealth(db, config, now).find((source) => source.id === "openrouter");
  expect(entry).toMatchObject({ mode: "shadow", state: "idle" });
  db.close();
});

test("an outage is announced once, and so is the recovery", async () => {
  const db = openDatabase(":memory:");
  const config = {
    ...loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname }),
    DISCORD_BOT_TOKEN: "token",
    alertChannelId: "999",
  };
  const posts: Record<string, unknown>[] = [];
  const request = async (_url: string, init?: RequestInit) => {
    posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ id: "1" });
  };
  const now = Date.parse("2026-09-08T12:00:00.000Z");
  const mark = (error: string | null, success: string | null) =>
    db
      .query(
        "INSERT INTO sources(id,last_error,last_success,checked_at) VALUES('openrouter',?,?,?) ON CONFLICT(id) DO UPDATE SET last_error=excluded.last_error,last_success=excluded.last_success,checked_at=excluded.checked_at",
      )
      .run(error, success, new Date(now).toISOString());

  mark("Source returned HTTP 500", null);
  // The first failed check is not an alert: today's outages lasted minutes and cleared themselves.
  expect((await publishAlerts(db, config, request, now)).down).toEqual([]);
  expect(posts).toHaveLength(0);
  expect((await publishAlerts(db, config, request, now)).down).toContain("openrouter");
  // The same outage on the next cycle is the same outage; it is not announced twice.
  const second = await publishAlerts(db, config, request, now);
  expect(second.down).toEqual([]);
  expect(posts).toHaveLength(1);

  mark(null, new Date(now).toISOString());
  const third = await publishAlerts(db, config, request, now);
  expect(third.recovered).toContain("openrouter");
  expect(posts).toHaveLength(2);
  expect((posts[1] as { embeds: { title: string }[] }).embeds[0]?.title).toBe("Signal Forge recovered");
});
test("an alert that cannot be delivered is retried, not forgotten", async () => {
  const db = openDatabase(":memory:");
  const config = {
    ...loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname }),
    DISCORD_BOT_TOKEN: "token",
    alertChannelId: "999",
  };
  let attempts = 0;
  const failing = async () => {
    attempts += 1;
    return new Response("{}", { status: 403 });
  };
  const now = Date.parse("2026-09-08T12:00:00.000Z");
  db.query("INSERT INTO sources(id,last_error,checked_at) VALUES('openrouter','boom',?)").run(
    new Date(now).toISOString(),
  );
  // Two checks to confirm the outage, then every later check retries the undelivered alert.
  await publishAlerts(db, config, failing, now);
  await publishAlerts(db, config, failing, now);
  await publishAlerts(db, config, failing, now);
  expect(attempts).toBe(2);
});

test("an unknown alert outcome is durably settled and never retried", async () => {
  const db = openDatabase(":memory:");
  const config = {
    ...loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname }),
    DISCORD_BOT_TOKEN: "token",
    alertChannelId: "999",
  };
  let attempts = 0;
  const now = Date.parse("2026-09-08T12:00:00.000Z");
  db.query("INSERT INTO sources(id,last_error,checked_at) VALUES('openrouter','gone',?)").run(
    new Date(now).toISOString(),
  );
  const request = async () => {
    attempts += 1;
    throw new Error("network failed after send");
  };
  await publishAlerts(db, config, request, now);
  await publishAlerts(db, config, request, now);
  await publishAlerts(db, config, request, now);
  expect(attempts).toBe(1);
  expect(db.query("SELECT status FROM alert_attempts").all()).toEqual([{ status: "ambiguous" }]);
  db.close();
});

test("interrupted alert sends become ambiguous before the next cycle", async () => {
  const db = openDatabase(":memory:");
  const config = {
    ...loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname }),
    DISCORD_BOT_TOKEN: "token",
    alertChannelId: "999",
  };
  const now = Date.parse("2026-09-08T12:00:00.000Z");
  db.query("INSERT INTO sources(id,last_error,checked_at) VALUES('openrouter','gone',?)").run(
    new Date(now).toISOString(),
  );
  db.query("INSERT INTO app_state(key,value) VALUES('alert_strikes',?)").run('{"openrouter":2}');
  db.query(
    "INSERT INTO alert_attempts(state_version,from_state_json,to_state_json,body,status,attempts,created_at,updated_at) VALUES(1,'[]','[\"openrouter\"]','{}','sending',1,?,?)",
  ).run(now, now);
  recoverInterruptedAlerts(db);
  let attempts = 0;
  await publishAlerts(
    db,
    config,
    async () => {
      attempts += 1;
      return Response.json({ id: "1" });
    },
    now,
  );
  expect(attempts).toBe(0);
  expect(db.query("SELECT status FROM alert_attempts").get()).toEqual({ status: "ambiguous" });
  db.close();
});

test("an interrupted alert advances the durable state before a changed next cycle", async () => {
  const db = openDatabase(":memory:");
  const config = {
    ...loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname }),
    DISCORD_BOT_TOKEN: "token",
    alertChannelId: "999",
  };
  const now = Date.parse("2026-09-08T12:00:00.000Z");
  db.query("INSERT INTO sources(id,last_error,checked_at) VALUES('openrouter','gone',?)").run(
    new Date(now).toISOString(),
  );
  db.query("INSERT INTO app_state(key,value) VALUES('alert_strikes',?)").run('{"openrouter":2}');
  db.query(
    "INSERT INTO alert_attempts(state_version,from_state_json,to_state_json,body,status,attempts,created_at,updated_at) VALUES(1,'[]','[\"openrouter\"]','{}','sending',1,?,?)",
  ).run(now, now);
  recoverInterruptedAlerts(db);
  db.query("UPDATE sources SET last_error=NULL,last_success=?,checked_at=? WHERE id='openrouter'").run(
    new Date(now).toISOString(),
    new Date(now).toISOString(),
  );
  let attempts = 0;
  await publishAlerts(
    db,
    config,
    async () => {
      attempts += 1;
      return Response.json({ id: "1" });
    },
    now,
  );
  expect(attempts).toBe(1);
  expect(db.query("SELECT status,state_version FROM alert_attempts ORDER BY state_version").all()).toEqual([
    { status: "ambiguous", state_version: 1 },
    { status: "sent", state_version: 2 },
  ]);
  db.close();
});

test("the platform board reads the stored observation and names the open incidents", () => {
  const db = openDatabase(":memory:");
  db.query("INSERT INTO snapshots(source,collected_at,raw_json) VALUES(?,?,?)").run(
    "status:openai",
    "2026-09-08T12:00:00.000Z",
    JSON.stringify({
      headline: "Partial System Degradation",
      indicator: "major",
      incidents: [{ name: "Elevated errors on the API", status: "investigating", impact: "major" }],
    }),
  );
  const embed = platformEmbed(db, Date.parse("2026-09-08T12:00:00.000Z")) as {
    description: string;
    color: number;
  };
  expect(embed.description).toContain("🟠 **OpenAI** — Partial System Degradation");
  expect(embed.description).toContain("Elevated errors on the API (investigating, major)");
  // A platform never read is not reported as healthy.
  expect(embed.description).toContain("**Anthropic** — not read yet");
});
test("the platform board uses the highest indicator severity", () => {
  const db = openDatabase(":memory:");
  const statuses: [string, string][] = [
    ["status:openai", "minor"],
    ["status:anthropic", "critical"],
  ];
  for (const [source, indicator] of statuses)
    db.query("INSERT INTO snapshots(source,collected_at,raw_json) VALUES(?,?,?)").run(
      source,
      "2026-09-08T12:00:00.000Z",
      JSON.stringify({ headline: indicator, indicator, incidents: [] }),
    );
  expect((platformEmbed(db, now) as { color: number }).color).toBe(0xe74c3c);
  db.close();
});
test("an incident becomes an event, and its resolution is a change rather than a deletion", () => {
  const open = {
    status: { description: "Partial System Degradation", indicator: "major" },
    incidents: [
      {
        id: "abc",
        name: "Elevated errors",
        status: "investigating",
        impact: "major",
        incident_updates: [{ body: "We are looking into it." }],
      },
    ],
  };
  const parsed = parsePlatformStatus(JSON.stringify(open), PLATFORMS[0] as (typeof PLATFORMS)[number]);
  expect(parsed.stream).toBe("incidents");
  expect(parsed.appendOnly).toBe(true);
  expect(parsed.trackChanges).toBe(true);
  expect(parsed.records[0]).toMatchObject({ id: "abc", name: "OpenAI: Elevated errors", stage: "investigating" });
  // A calm platform reports no incidents, and that is a valid observation, not an empty collection.
  const calm = JSON.stringify({ status: { description: "All Systems Operational", indicator: "none" }, incidents: [] });
  expect(parsePlatformStatus(calm, PLATFORMS[0] as (typeof PLATFORMS)[number]).records).toHaveLength(0);
});

test("many collectors failing together is reported as one shared path", async () => {
  const db = openDatabase(":memory:");
  const config = {
    ...loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname }),
    DISCORD_BOT_TOKEN: "token",
    alertChannelId: "999",
  };
  const posts: { embeds: { description: string }[] }[] = [];
  const request = async (_url: string, init?: RequestInit) => {
    posts.push(JSON.parse(String(init?.body)) as { embeds: { description: string }[] });
    return Response.json({ id: "1" });
  };
  const now = Date.parse("2026-09-08T12:00:00.000Z");
  for (const id of ["openrouter", "openai-news", "anthropic-news", "arena", "arena-leaderboards"])
    db.query("INSERT INTO sources(id,last_error,checked_at) VALUES(?,'gone',?)").run(id, new Date(now).toISOString());

  await publishAlerts(db, config, request, now);
  await publishAlerts(db, config, request, now);
  expect(posts).toHaveLength(1);
  const description = posts[0]?.embeds[0]?.description ?? "";
  // Naming five collectors teaches nothing that "five at once" does not.
  expect(description).toContain("5 collectors stopped reporting at once");
  expect(description).toContain("one shared path");
});
