import { expect, test } from "bun:test";
import { signalClass } from "../src/events/signals.js";
import type { Event } from "../src/events/types.js";
import { APP_STORE_APPS, collectAppStore, parseAppStore } from "../src/sources/apps.js";

const app = APP_STORE_APPS[0] as (typeof APP_STORE_APPS)[number];

const listing = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    resultCount: 1,
    results: [
      {
        trackId: 6448311069,
        trackName: "ChatGPT",
        version: "1.2026.244",
        currentVersionReleaseDate: "2026-09-08T17:02:31Z",
        releaseNotes: "  Voice mode is faster.\n\nBug fixes and improvements.  ",
        trackViewUrl: "https://apps.apple.com/us/app/chatgpt/id6448311069",
        sellerName: "OpenAI",
        minimumOsVersion: "17.0",
        ...overrides,
      },
    ],
  });

test("an App Store listing becomes one record with the version, date and vendor notes", () => {
  const collection = parseAppStore(listing(), app);
  expect(collection.source).toBe("app:ios:chatgpt");
  expect(collection.stream).toBe("apps");
  expect(collection.records).toEqual([
    {
      id: "ios:6448311069",
      name: "ChatGPT for iOS",
      version: "1.2026.244",
      released: "2026-09-08T17:02:31Z",
      maker: "OpenAI",
      platform: "iOS",
      url: "https://apps.apple.com/us/app/chatgpt/id6448311069",
      summary: "Voice mode is faster. · Bug fixes and improvements.",
      requires: "iOS 17.0",
    },
  ]);
});

test("a listing without release notes still records the release", () => {
  const collection = parseAppStore(listing({ releaseNotes: undefined }), app);
  expect(collection.records[0]).not.toHaveProperty("summary");
  expect(collection.records[0]).toMatchObject({ version: "1.2026.244" });
});

test("an empty lookup is a failed observation, never a withdrawn app", () => {
  expect(() => parseAppStore(JSON.stringify({ resultCount: 0, results: [] }), app)).toThrow("no listing");
});

test("a malformed lookup never becomes an empty catalogue", () => {
  expect(() => parseAppStore("not json", app)).toThrow();
  expect(() => parseAppStore(JSON.stringify({ resultCount: 1, results: [{ trackId: 1 }] }), app)).toThrow();
});

test("the collector asks Apple for one listing and keeps credentials out of the URL", async () => {
  let seen = "";
  const collection = await collectAppStore(app, async (url) => {
    seen = String(url);
    return new Response(listing(), { status: 200, headers: { "content-type": "application/json" } });
  });
  expect(seen).toBe("https://itunes.apple.com/lookup?id=6448311069&country=us&entity=software");
  expect(collection.records).toHaveLength(1);
});

test("a released app version reaches the readers who asked for launches", () => {
  const event: Event = {
    id: 1,
    source: "app:ios:chatgpt",
    stream: "apps",
    entity_id: "ios:6448311069",
    kind: "changed",
    before_json: JSON.stringify({ id: "ios:6448311069", name: "ChatGPT for iOS", version: "1.2026.243" }),
    after_json: JSON.stringify({ id: "ios:6448311069", name: "ChatGPT for iOS", version: "1.2026.244" }),
    detected_at: "2026-09-11T00:00:00.000Z",
  };
  expect(signalClass(event)).toBe("launch");
});
