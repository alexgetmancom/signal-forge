import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { renderRecapEmbed } from "../src/events/render/lifecycle.js";
import { recapContextSchema } from "../src/recap.js";
import { prepareWeeklyLead, publishMonthlyAudit } from "../src/review.js";
import { readState } from "../src/storage/appState.js";
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

test("the weekly lead is written once, in the hours before the week closes", async () => {
  const db = openDatabase(":memory:");
  seedDelivery(db, "2026-09-18T10:00:00.000Z");
  const seen = { urls: [] as string[], bodies: [] as string[] };
  const request = deepseek(
    "Google released **Gemini 3.8 Live**, see https://x.test @everyone.",
    seen,
  ) as unknown as typeof fetch;
  // Sunday 2026-09-20 18:00 UTC closes the week; Saturday is too early.
  expect(await prepareWeeklyLead(db, config, request, Date.parse("2026-09-19T12:00:00Z"))).toBe(false);
  expect(await prepareWeeklyLead(db, config, request, Date.parse("2026-09-20T16:00:00Z"))).toBe(true);
  expect(await prepareWeeklyLead(db, config, request, Date.parse("2026-09-20T17:00:00Z"))).toBe(false);
  expect(seen.urls).toHaveLength(1);
  expect(seen.bodies[0]).toContain('"thinking":{"type":"disabled"}');
  expect(seen.bodies[0]).toContain("Gemini 3.8 Live");
  const lead = readState(db, "weekly-lead:2026-09-20T18:00:00.000Z");
  expect(lead).toBe("Google released Gemini 3.8 Live, see everyone.");
});

test("the lead opens the weekly recap and nothing else", () => {
  const context = recapContextSchema.parse({
    period: "week",
    from: "2026-09-13T18:00:00.000Z",
    to: "2026-09-20T18:00:00.000Z",
    arrivals: [{ vendor: "Google", names: ["Gemini 3.8 Live"] }],
    arrivalCount: 1,
    priceMoves: [],
    codenameCount: 0,
    lead: "Google released Gemini 3.8 Live.",
  });
  const embed = renderRecapEmbed(context, ["launch"]);
  expect(String(embed?.description)).toStartWith("Google released Gemini 3.8 Live.\n\n");
});

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

test("the lead reads the week's cards, not last week's recap", async () => {
  const db = openDatabase(":memory:");
  seedDelivery(db, "2026-09-18T10:00:00.000Z");
  // The previous recap, reposted inside this week: summarising it is how a week opened by
  // describing the one before it.
  seedDelivery(db, "2026-09-14T09:00:00.000Z", "weekly_recap", "THE WEEK IN MODELS: 16 models arrived");
  const seen = { urls: [] as string[], bodies: [] as string[] };
  const request = deepseek("A week happened.", seen) as unknown as typeof fetch;
  expect(await prepareWeeklyLead(db, config, request, Date.parse("2026-09-20T16:00:00Z"))).toBe(true);
  expect(seen.bodies[0]).toContain("Gemini 3.8 Live");
  expect(seen.bodies[0]).not.toContain("THE WEEK IN MODELS");
});

test("a paragraph too long for the recap ends on a sentence, not mid-word", async () => {
  const db = openDatabase(":memory:");
  seedDelivery(db, "2026-09-18T10:00:00.000Z");
  const seen = { urls: [] as string[], bodies: [] as string[] };
  const sentence = `${"Google shipped a model that is quite good indeed. ".repeat(15)}GPT-5.5 retires on October`;
  const request = deepseek(sentence, seen) as unknown as typeof fetch;
  expect(await prepareWeeklyLead(db, config, request, Date.parse("2026-09-20T16:00:00Z"))).toBe(true);
  const lead = readState(db, "weekly-lead:2026-09-20T18:00:00.000Z") ?? "";
  expect(lead.length).toBeLessThanOrEqual(700);
  expect(lead.endsWith(".")).toBe(true);
  expect(lead).not.toContain("retires on Octo");
});
