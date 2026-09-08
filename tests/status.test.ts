import { expect, test } from "bun:test";
import { publishAlerts } from "../src/alerts.js";
import { loadConfig } from "../src/config.js";
import { publishStatus, sourceHealth, statusEmbed } from "../src/status.js";
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

test("a source that missed three of its own intervals is stale, not failing", () => {
  const db = openDatabase(":memory:");
  const old = new Date(now - 4 * 300 * 1000).toISOString();
  seed(db, "openrouter", { last_success: old, checked_at: old });
  expect(sourceHealth(db, withStatus, now).find((entry) => entry.id === "openrouter")?.state).toBe("stale");
  db.close();
});

test("the board posts once and edits afterwards", async () => {
  const db = openDatabase(":memory:");
  seed(db, "openrouter", { last_success: new Date(now - 1000).toISOString(), checked_at: new Date(now).toISOString() });

  const calls: string[] = [];
  const request = async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method} ${String(url).split("/channels/")[1]}`);
    return new Response(JSON.stringify({ id: "555" }), { status: 200 });
  };
  expect(await publishStatus(db, withStatus, request, now)).toBe("created");
  // Nothing moved, so the board is not rewritten: an unchanged status is not an event.
  expect(await publishStatus(db, withStatus, request, now)).toBe("unchanged");

  seed(db, "arena", { last_error: "Source returned HTTP 500", checked_at: new Date(now).toISOString() });
  expect(await publishStatus(db, withStatus, request, now)).toBe("edited");
  expect(calls).toEqual(["POST 99/messages", "PATCH 99/messages/555"]);
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
    return new Response("{}", { status: 200 });
  };
  const now = Date.parse("2026-09-08T12:00:00.000Z");
  const mark = (error: string | null, success: string | null) =>
    db
      .query(
        "INSERT INTO sources(id,last_error,last_success,checked_at) VALUES('openrouter',?,?,?) ON CONFLICT(id) DO UPDATE SET last_error=excluded.last_error,last_success=excluded.last_success,checked_at=excluded.checked_at",
      )
      .run(error, success, new Date(now).toISOString());

  mark("Source returned HTTP 500", null);
  expect((await publishAlerts(db, config, request, now)).down).toContain("openrouter");
  // The same outage on the next cycle is the same outage; it is not announced twice.
  const second = await publishAlerts(db, config, request, now);
  expect(second.down).toEqual([]);
  expect(posts).toHaveLength(1);

  mark(null, new Date(now).toISOString());
  const third = await publishAlerts(db, config, request, now);
  expect(third.recovered).toContain("openrouter");
  expect(posts).toHaveLength(2);
  expect((posts[1] as { embeds: { title: string }[] }).embeds[0]?.title).toBe("Collectors recovered");
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
  await publishAlerts(db, config, failing, now);
  await publishAlerts(db, config, failing, now);
  expect(attempts).toBe(2);
});
