import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { renderRecapEmbed } from "../src/events/render/lifecycle.js";
import { recapContextSchema } from "../src/recap/schema.js";
import { publishMonthlyAudit, publishWeeklyVotes } from "../src/review.js";
import { readState, writeState } from "../src/storage/appState.js";
import { openDatabase } from "../src/storage/database.js";

const fixture = new URL("./fixtures/config.json", import.meta.url).pathname;
const base = loadConfig({ CONFIG_PATH: fixture });
const config = {
  ...base,
  DEEPSEEK_API_KEY: "ds",
  DISCORD_BOT_TOKEN: "bot",
  statusChannelId: "123",
  destinations: [
    { id: "discord-signals", platform: "discord", channelId: "1", signals: ["launch"], minimumSeverity: "info" },
  ],
} as unknown as typeof base;

function seedDelivery(db: ReturnType<typeof openDatabase>, at: string, kind = "event", title = "Gemini 3.8 Live") {
  const destination = config.destinations[0];
  if (!destination) throw new Error("fixture has no destination");
  const batch = db
    .query<{ id: number }, [string, string]>(
      "INSERT INTO batches(source,digest,ready_at,kind) VALUES('x',0,?,?) RETURNING id",
    )
    .get(at, kind);
  db.query(
    "INSERT INTO deliveries(batch_id,destination_id,destination_json,body,part,status,updated_at) VALUES(?,?,?,?,0,'sent',?)",
  ).run(batch?.id ?? 0, destination.id, JSON.stringify(destination), JSON.stringify({ embeds: [{ title }] }), at);
}

function deepseek(text: string, seen: { urls: string[]; bodies: string[] }) {
  return async (url: string, init?: RequestInit) => {
    seen.urls.push(url);
    seen.bodies.push(String(init?.body ?? ""));
    if (url.includes("discord.com")) return Response.json({ id: "1" });
    return Response.json({ choices: [{ message: { content: text } }] });
  };
}

test("the monthly audit goes to the status channel once, on the first", async () => {
  const db = openDatabase(":memory:");
  seedDelivery(db, "2026-09-18T10:00:00.000Z");
  const seen = { urls: [] as string[], bodies: [] as string[] };
  const long = Array.from({ length: 120 }, (_, i) => `- line ${i} ${"x".repeat(60)}`).join("\n");
  const request = deepseek(`**Missed**\n${long}`, seen) as unknown as typeof fetch;
  expect(await publishMonthlyAudit(db, config, request, Date.parse("2026-09-30T12:00:00Z"))).toBe(false);
  expect(await publishMonthlyAudit(db, config, request, Date.parse("2026-10-01T08:00:00Z"))).toBe(true);
  expect(await publishMonthlyAudit(db, config, request, Date.parse("2026-10-01T09:00:00Z"))).toBe(false);
  const posts = seen.urls.filter((url) => url.includes("discord.com"));
  expect(posts.length).toBeGreaterThan(1);
  expect(posts.every((url) => url.includes("/channels/123/messages"))).toBe(true);
  expect(readState(db, "audit:2026-10")).toBe("sent");
});

test("nothing a model wrote reaches the weekly recap", () => {
  // A DeepSeek paragraph opened it until 2026-09-21. It was removed rather than fixed: the facts in
  // it were already the lines below it, in fewer words and with nothing invented between them.
  const context = recapContextSchema.parse({
    period: "week",
    from: "2026-09-13T18:00:00.000Z",
    to: "2026-09-20T18:00:00.000Z",
    arrivals: [{ vendor: "Google", names: ["Gemini 3.8 Live"] }],
    arrivalCount: 1,
    priceMoves: [],
    codenameCount: 0,
    lead: "The most significant development this week was the arrival of 16 new models.",
  });
  expect("lead" in context).toBe(false);
  const embed = renderRecapEmbed(context, ["launch"]);
  expect(String(embed?.description)).not.toContain("most significant development");
  expect(String(embed?.description)).toStartWith("🚀 **1 model arrived**");
  expect(String(embed?.title)).toContain("13–20 September");
});

test("the readers' votes go to the status channel once, on Monday", async () => {
  const db = openDatabase(":memory:");
  seedDelivery(db, "2026-09-25T10:00:00.000Z", "event", "GPT-6 Astra is out");
  db.query(
    "INSERT INTO scout_reactions(delivery_id,votes,against,read_at) VALUES(1,4,1,'2026-09-26T10:00:00.000Z')",
  ).run();
  const seen = { urls: [] as string[], bodies: [] as string[] };
  const request = deepseek("", seen) as unknown as typeof fetch;
  expect(await publishWeeklyVotes(db, config, request, Date.parse("2026-09-27T12:00:00Z"))).toBe(false);
  expect(await publishWeeklyVotes(db, config, request, Date.parse("2026-09-28T08:00:00Z"))).toBe(true);
  expect(await publishWeeklyVotes(db, config, request, Date.parse("2026-09-28T09:00:00Z"))).toBe(false);
  expect(seen.urls).toEqual(["https://discord.com/api/v10/channels/123/messages"]);
  expect(seen.bodies[0]).toContain("👍 4 · GPT-6 Astra is out");
  expect(seen.bodies[0]).toContain("👎 1");
});

/** DeepSeek and Discord that can each be told to fail, and a count of what each was asked. */
function flaky(chunks = "**Missed**\n- a line") {
  const behaviour = {
    deepseek: "up" as "up" | "503",
    discord: "up" as "up" | "403" | "down",
    discordFailsAfter: Infinity,
  };
  const asked = { deepseek: 0, discord: 0 };
  const request = (async (url: string) => {
    if (url.includes("discord.com")) {
      asked.discord += 1;
      if (behaviour.discord === "down" || asked.discord > behaviour.discordFailsAfter)
        throw new TypeError("socket closed");
      return behaviour.discord === "403" ? new Response("no", { status: 403 }) : Response.json({ id: "1" });
    }
    asked.deepseek += 1;
    return behaviour.deepseek === "503"
      ? new Response("overloaded", { status: 503 })
      : Response.json({ choices: [{ message: { content: chunks } }] });
  }) as unknown as typeof fetch;
  return { behaviour, asked, request };
}

test("an audit that posted nothing is tried again an hour later, and a restart mid-audit still never doubles it", async () => {
  // The month's audit was claimed before the slow read so that a restart could not post it twice,
  // and a DeepSeek 503 at seven o'clock on the first left that claim in place for the month.
  const db = openDatabase(":memory:");
  seedDelivery(db, "2026-09-18T10:00:00.000Z");
  const remote = flaky();
  remote.behaviour.deepseek = "503";
  expect(await publishMonthlyAudit(db, config, remote.request, Date.parse("2026-10-01T08:00:00Z"))).toBe(false);
  expect(readState(db, "audit:2026-10")).toStartWith("retry:");
  // Not asked again within the hour: a provider that is down is not a reason to ask every cycle.
  expect(await publishMonthlyAudit(db, config, remote.request, Date.parse("2026-10-01T08:30:00Z"))).toBe(false);
  expect(remote.asked.deepseek).toBe(1);
  remote.behaviour.deepseek = "up";
  expect(await publishMonthlyAudit(db, config, remote.request, Date.parse("2026-10-01T09:05:00Z"))).toBe(true);
  expect(readState(db, "audit:2026-10")).toBe("sent");
  expect(await publishMonthlyAudit(db, config, remote.request, Date.parse("2026-10-01T23:00:00Z"))).toBe(false);
  expect(remote.asked.discord).toBe(1);

  // A claim with no outcome is a process that stopped in the middle: it may have posted, so it is not retried.
  const interrupted = openDatabase(":memory:");
  seedDelivery(interrupted, "2026-09-18T10:00:00.000Z");
  writeState(interrupted, "audit:2026-10", "claimed");
  const untouched = flaky();
  expect(await publishMonthlyAudit(interrupted, config, untouched.request, Date.parse("2026-10-01T12:00:00Z"))).toBe(
    false,
  );
  expect(untouched.asked).toEqual({ deepseek: 0, discord: 0 });
});

test("an audit whose first post was refused is tried again, and one that was partly posted is not", async () => {
  const long = Array.from({ length: 120 }, (_, i) => `- line ${i} ${"x".repeat(60)}`).join("\n");
  const refused = openDatabase(":memory:");
  seedDelivery(refused, "2026-09-18T10:00:00.000Z");
  const remote = flaky(`**Missed**\n${long}`);
  remote.behaviour.discord = "403";
  expect(await publishMonthlyAudit(refused, config, remote.request, Date.parse("2026-10-01T08:00:00Z"))).toBe(false);
  expect(readState(refused, "audit:2026-10")).toStartWith("retry:");
  remote.behaviour.discord = "up";
  expect(await publishMonthlyAudit(refused, config, remote.request, Date.parse("2026-10-01T09:05:00Z"))).toBe(true);

  // The first part reached the channel and the second did not: posting it all again would double
  // what is already there, so this month's audit stays as it is.
  const partial = openDatabase(":memory:");
  seedDelivery(partial, "2026-09-18T10:00:00.000Z");
  const half = flaky(`**Missed**\n${long}`);
  half.behaviour.discordFailsAfter = 1;
  expect(await publishMonthlyAudit(partial, config, half.request, Date.parse("2026-10-01T08:00:00Z"))).toBe(false);
  expect(readState(partial, "audit:2026-10")).toBe("claimed");
  half.behaviour.discordFailsAfter = Infinity;
  expect(await publishMonthlyAudit(partial, config, half.request, Date.parse("2026-10-01T10:00:00Z"))).toBe(false);
});

test("the readers' votes are tried again when Discord did not take them", async () => {
  const db = openDatabase(":memory:");
  seedDelivery(db, "2026-09-25T10:00:00.000Z", "event", "GPT-6 Astra is out");
  const remote = flaky();
  remote.behaviour.discord = "down";
  const monday = Date.parse("2026-10-05T08:00:00Z");
  expect(await publishWeeklyVotes(db, config, remote.request, monday)).toBe(false);
  expect(readState(db, "votes:2026-10-05")).toStartWith("retry:");
  remote.behaviour.discord = "up";
  expect(await publishWeeklyVotes(db, config, remote.request, monday + 3_600_000 + 60_000)).toBe(true);
  expect(readState(db, "votes:2026-10-05")).toBe("sent");
  expect(await publishWeeklyVotes(db, config, remote.request, monday + 7_200_000)).toBe(false);
});
