import { expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import { readerStanding } from "../src/events/confidence.js";
import { type Collection, prepareDeliveries, saveCollection } from "../src/events.js";
import { suppressionEmbed } from "../src/status.js";
import { openDatabase } from "../src/storage/database.js";

const destination: Destination = { id: "changes", platform: "discord", channelId: "1", signals: ["change"] };

const catalogue = (completion: string): Collection => ({
  source: "openrouter",
  stream: "openrouter",
  url: "https://openrouter.ai/models",
  raw: [],
  records: [{ id: "deepseek/v4-pro", name: "DeepSeek: V4 Pro", pricing: { completion } }],
});

type Row = { reason: string; detail: string; destination_id: string };

function suppressions(db: ReturnType<typeof openDatabase>): Row[] {
  return db.query<Row, []>("SELECT reason,detail,destination_id FROM suppressions ORDER BY event_id").all();
}

test("a price move under the threshold says in writing why it stayed quiet", () => {
  const db = openDatabase(":memory:");
  const start = Date.parse("2026-09-11T01:00:00.000Z");
  // $1.896 → $1.720 per million: the real DeepSeek V4 Pro move that produced an empty digest.
  saveCollection(db, catalogue("0.000001896"), [destination], new Date(start).toISOString());
  saveCollection(db, catalogue("0.00000172"), [destination], new Date(start + 3_600_000).toISOString());
  prepareDeliveries(db, start + 2 * 3_600_000);

  expect(db.query<{ c: number }, []>("SELECT COUNT(*) c FROM deliveries").get()?.c).toBe(0);
  const recorded = suppressions(db);
  expect(recorded).toHaveLength(1);
  expect(recorded[0]?.reason).toBe("no_reader_facing_change");
  expect(recorded[0]?.detail).toBe("Price moved 9.3%, under the 10% threshold");
  expect(recorded[0]?.destination_id).toBe("changes");
  db.close();
});

test("an event that speaks leaves no suppression behind", () => {
  const db = openDatabase(":memory:");
  const start = Date.parse("2026-09-11T01:00:00.000Z");
  saveCollection(db, catalogue("0.000015"), [destination], new Date(start).toISOString());
  saveCollection(db, catalogue("0.000005"), [destination], new Date(start + 3_600_000).toISOString());
  prepareDeliveries(db, start + 2 * 3_600_000);

  expect(db.query<{ c: number }, []>("SELECT COUNT(*) c FROM deliveries").get()?.c).toBeGreaterThan(0);
  expect(suppressions(db)).toHaveLength(0);
  db.close();
});

test("a held move records the wait and names the destination that is already caught up", () => {
  const db = openDatabase(":memory:");
  const hour = 3_600_000;
  const start = Date.parse("2026-09-11T01:00:00.000Z");
  const steps = ["0.000015", "0.000013", "0.0000117"];
  steps.forEach((price, index) => {
    saveCollection(db, catalogue(price), [destination], new Date(start + index * hour).toISOString());
    prepareDeliveries(db, start + index * hour + hour / 2);
  });
  // The hour that holds the last step only comes round on its own schedule.
  prepareDeliveries(db, start + 3 * hour);

  const recorded = suppressions(db);
  expect(recorded).toHaveLength(1);
  expect(recorded[0]?.reason).toBe("waiting_for_the_move_to_settle");
  expect(recorded[0]?.detail).toContain("six hours ago");
  db.close();
});

test("a title that gained punctuation is not an announcement", () => {
  const db = openDatabase(":memory:");
  const start = Date.parse("2026-09-12T01:00:00.000Z");
  const named = (name: string): Collection => ({
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai/models",
    raw: [],
    records: [{ id: "anthropic/claude-sonnet-latest", name, pricing: { completion: "0.000001" } }],
  });
  // OpenRouter restyled every title in one pass, and OpenAI wrapped every deprecated id in
  // backticks the same morning: nineteen cards about punctuation.
  saveCollection(db, named("Anthropic Claude Sonnet Latest"), [destination], new Date(start).toISOString());
  saveCollection(
    db,
    named("Anthropic: Claude Sonnet Latest"),
    [destination],
    new Date(start + 3_600_000).toISOString(),
  );
  prepareDeliveries(db, start + 2 * 3_600_000);

  expect(db.query<{ c: number }, []>("SELECT COUNT(*) c FROM deliveries").get()?.c).toBe(0);
  expect(suppressions(db)).toEqual([
    {
      reason: "no_reader_facing_change",
      detail: "The wording changed, the thing behind it did not",
      destination_id: "changes",
    },
  ]);
  db.close();
});

test("the board counts what was held back beside what actually spoke", () => {
  const db = openDatabase(":memory:");
  const start = Date.parse("2026-09-12T01:00:00.000Z");
  saveCollection(db, catalogue("0.000001896"), [destination], new Date(start).toISOString());
  saveCollection(db, catalogue("0.00000172"), [destination], new Date(start + 3_600_000).toISOString());
  prepareDeliveries(db, start + 2 * 3_600_000);

  const embed = suppressionEmbed(db, start + 2 * 3_600_000);
  expect(embed.title).toBe("Filtered out, last 24 hours");
  expect(String(embed.description)).toContain("**1** events held back · **0** reached a channel");
  expect(String(embed.description)).toContain("**1** · no reader facing change");
  db.close();
});

test("a card says how solid it is in words a non-specialist reads", () => {
  const standing = (source: string, stream: string, evidence: string, confidence: string) =>
    readerStanding({ source, stream, evidence_type: evidence, confidence } as never);

  // The difference between a rumour and a fact used to live in a footer reading
  // "Evidence: arena roster · Confidence: observed".
  expect(standing("arena", "arena", "arena_roster", "observed")).toBe(
    "Spotted on a public arena. Nobody has said what it is yet.",
  );
  // A reseller listing a model is not the maker announcing it.
  expect(standing("openrouter", "openrouter", "availability_catalogue", "observed")).toBe(
    "Seen in a reseller's catalogue, not announced by the maker.",
  );
  expect(standing("openai-news", "news", "official_news", "supported")).toBe("The maker announced this themselves.");
  expect(standing("npm:x", "packages", "package_release", "shipped")).toBe(
    "Published to the registry. You can install it now.",
  );
  // An unrecognised evidence type still says something rather than nothing.
  expect(standing("whatever", "other", "unknown", "confirmed")).toBe("Confirmed by the provider directly.");
});
