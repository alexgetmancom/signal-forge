import { expect, test } from "bun:test";
import { readerStanding } from "../src/events/confidence.js";
import { pingWorthy, signalClass } from "../src/events/signals.js";
import { collectCodexResets } from "../src/sources/resets.js";

const announcement = {
  id: "2098685367058612394",
  reset_type: "regular",
  announced_at: "2026-09-12T08:09:17.000Z",
  text: "Reset all propagated. Sweet dreams.",
  source: { type: "x_post", author: "thsottiaux", url: "https://x.com/thsottiaux/status/2098685367058612394" },
};

const banked = {
  id: "2000000000000000001",
  reset_type: "banked",
  announced_at: "2026-08-01T10:00:00.000Z",
  text: "Banked a reset for everyone.",
  source: { type: "observed" },
};

function server(pages: unknown[], stats: Record<string, unknown>) {
  const requests: string[] = [];
  const fetcher = async (url: string | URL): Promise<Response> => {
    const address = String(url);
    requests.push(address);
    if (address.includes("/status")) return Response.json({ data: { stats }, meta: {} });
    const index = new URL(address).searchParams.get("cursor") === null ? 0 : 1;
    return Response.json(pages[index]);
  };
  return { requests, fetcher };
}

const page = (data: unknown[], next: string | null = null) => ({
  data,
  pagination: { has_more: Boolean(next), next_cursor: next },
});

test("the whole history is collected oldest first, forecasts stay out of the records", async () => {
  const { fetcher, requests } = server([page([banked], "cursor1"), page([announcement])], {
    total: 2,
    last_reset_at: announcement.announced_at,
    days_since_last: 0.1,
    avg_interval_days: 6.9,
  });
  const collection = await collectCodexResets(fetcher);

  expect(collection.source).toBe("codex-resets");
  expect(collection.stream).toBe("resets");
  expect(collection.appendOnly).toBe(true);
  expect(requests.some((url) => url.includes("cursor=cursor1"))).toBe(true);
  expect(collection.records.map((record) => record.id)).toEqual([banked.id, announcement.id]);
  expect(collection.records[0]?.name).toBe("Codex banked reset credit granted");
  expect(collection.records[0]?.announcement).toBe("Observed without an announcement");
  expect(collection.records[1]?.announcement).toBe("Posted by @thsottiaux on X");
  expect(collection.records[1]?.url).toBe(announcement.source.url);
  // A forecast is retained as evidence and is never a record that says limits came back.
  const raw = collection.raw as Record<string, unknown>;
  expect(raw.active_watch).toBeNull();
  expect(raw.scheduled_reset).toBeNull();
});

test("a short or empty history is a failed read, never a history without resets", async () => {
  const empty = server([page([])], { total: 0 });
  expect(collectCodexResets(empty.fetcher)).rejects.toThrow("empty");

  const short = server([page([announcement])], { total: 53 });
  expect(collectCodexResets(short.fetcher)).rejects.toThrow("short");
});

test("a reset travels with the launches", () => {
  const event = {
    id: 1,
    source: "codex-resets",
    stream: "resets",
    entity_id: announcement.id,
    kind: "new" as const,
    before_json: null,
    after_json: JSON.stringify({ id: announcement.id, name: "Codex usage limits reset for everyone" }),
    detected_at: announcement.announced_at,
  };
  expect(signalClass(event)).toBe("launch");
  expect(pingWorthy(event)).toBe(true);
});

test("the card says how solid a reset is from the record, not from the stream", () => {
  const event = (announcement: string) => ({
    id: 1,
    source: "codex-resets",
    stream: "resets",
    entity_id: "1",
    kind: "new" as const,
    before_json: null,
    after_json: JSON.stringify({ id: "1", name: "Codex usage limits reset for everyone", announcement }),
    detected_at: "2026-09-12T08:09:17.000Z",
  });
  expect(readerStanding(event("Posted by @thsottiaux on X"))).toContain("Announced by the OpenAI staff member");
  expect(readerStanding(event("Observed without an announcement"))).toContain("no announcement behind it");
});
