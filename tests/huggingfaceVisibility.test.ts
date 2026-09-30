import { expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import { prepareDeliveries } from "../src/events/batching.js";
import { saveCollection } from "../src/events/pipeline.js";
import { eventEmbed, rosterEmbed } from "../src/events/render/discord.js";
import type { Event } from "../src/events/types.js";
import type { Fetch } from "../src/http-client.js";
import { collectHuggingFace, parseHuggingFace } from "../src/sources/registries.js";
import { openDatabase } from "../src/storage/database.js";
import { readLatestSnapshot } from "../src/storage/snapshots.js";

const radar: Destination = { id: "radar", platform: "discord", channelId: "1", signals: ["codename"] };
const start = "https://huggingface.co/api/models?author=google&sort=createdAt&direction=-1&limit=1000";
const next = `${start}&cursor=next`;
const model = (id: string, privateRepo = false) => ({
  id: `google/${id}`,
  author: "google",
  createdAt: "2026-07-31T06:56:11.000Z",
  pipeline_tag: "tabular-classification",
  private: privateRepo,
});
const page = (models: ReturnType<typeof model>[], following?: string) =>
  new Response(JSON.stringify(models), { headers: following ? { link: `<${following}>; rel="next"` } : {} });

test("the first complete catalogue is quiet, then old repositories becoming public reach radar", async () => {
  const db = openDatabase(":memory:");
  try {
    // A partial listing already exists; widening its coverage must not announce its old tail.
    saveCollection(
      db,
      { ...parseHuggingFace(JSON.stringify([model("anchor")]), "google"), appendOnly: true },
      [radar],
      "2026-09-30T06:00:00.000Z",
    );
    const urls: string[] = [];
    let opened = false;
    const request: Fetch = async (url) => {
      urls.push(String(url));
      if (String(url) === start) return page([model("anchor")], next);
      expect(String(url)).toBe(next);
      return page([model("tabfm-1.1.0-pytorch"), model("hidden", !opened)]);
    };
    const baseline = await collectHuggingFace(db, "google", undefined, request);
    expect(urls).toEqual([start, next]);
    expect(baseline.silentIds).toContain("google/tabfm-1.1.0-pytorch");
    expect(baseline.records.map((row) => row.id)).not.toContain("google/hidden");
    expect(saveCollection(db, { ...baseline, appendOnly: true }, [radar], "2026-09-30T06:10:00.000Z").events).toBe(0);
    opened = true;
    const visible = await collectHuggingFace(db, "google", undefined, request);
    expect(visible.silentIds).toEqual([]);
    expect(saveCollection(db, { ...visible, appendOnly: true }, [radar], "2026-09-30T06:20:00.000Z").events).toBe(1);
    prepareDeliveries(db, Date.parse("2026-09-30T07:00:00.000Z"));
    const bodies = db.query<{ body: string }, []>("SELECT body FROM deliveries").all();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.body).toContain("hidden appears on Hugging Face");
    expect(bodies[0]?.body).not.toContain("tabfm");
    expect(
      saveCollection(
        db,
        { ...(await collectHuggingFace(db, "google", undefined, request)), appendOnly: true },
        [radar],
        "2026-09-30T07:10:00.000Z",
      ).events,
    ).toBe(0);
  } finally {
    db.close();
  }
});

test("a failed later page leaves the established baseline intact", async () => {
  const db = openDatabase(":memory:");
  try {
    const baseline = await collectHuggingFace(db, "google", undefined, async () => page([model("anchor")]));
    saveCollection(db, { ...baseline, appendOnly: true }, [radar], "2026-09-30T06:00:00.000Z");
    const before = readLatestSnapshot(db, "huggingface:google");
    await expect(
      collectHuggingFace(db, "google", undefined, async (url) =>
        String(url) === start ? page([model("anchor"), model("opened")], next) : new Response("", { status: 429 }),
      ),
    ).rejects.toThrow();
    expect(readLatestSnapshot(db, "huggingface:google")).toBe(before);
    const recovered = await collectHuggingFace(db, "google", undefined, async () =>
      page([model("anchor"), model("opened")]),
    );
    expect(recovered.silentIds).toEqual([]);
    expect(saveCollection(db, { ...recovered, appendOnly: true }, [radar], "2026-09-30T07:00:00.000Z").events).toBe(1);
  } finally {
    db.close();
  }
});

test("an unsaved or rolled-back complete read cannot establish a baseline", async () => {
  const db = openDatabase(":memory:");
  try {
    const request: Fetch = async () => page([model("anchor"), model("old")]);
    const baseline = await collectHuggingFace(db, "google", undefined, request);
    expect(() =>
      db.transaction(() => {
        saveCollection(db, { ...baseline, appendOnly: true }, [radar], "2026-09-30T06:00:00.000Z");
        throw new Error("rollback");
      })(),
    ).toThrow("rollback");
    expect(readLatestSnapshot(db, "huggingface:google")).toBeNull();
    expect((await collectHuggingFace(db, "google", undefined, request)).silentIds).toEqual([
      "google/anchor",
      "google/old",
    ]);
  } finally {
    db.close();
  }
});

test("pagination cannot cycle or send an account token to another origin", async () => {
  const db = openDatabase(":memory:");
  try {
    for (const following of [start, "https://other.example/models"]) {
      let calls = 0;
      await expect(
        collectHuggingFace(db, "google", "test-token", async () => {
          calls++;
          return page([model("anchor")], following);
        }),
      ).rejects.toThrow("invalid pagination link");
      expect(calls).toBe(1);
    }
  } finally {
    db.close();
  }
});

test("two weight repositories are described as public appearances, not two new models", () => {
  const events = ["tabfm-1.1.0-pytorch", "tabfm-1.1.0-jax"].map((id, index): Event & { url: string } => ({
    id: index + 1,
    source: "huggingface:google",
    stream: "weights",
    entity_id: `google/${id}`,
    kind: "new",
    before_json: null,
    after_json: JSON.stringify({ ...model(id), name: `google/${id}` }),
    detected_at: "2026-09-30T06:31:07.014Z",
    url: `https://huggingface.co/google/${id}`,
    signal: "codename",
  }));
  const first = events[0] as Event & { url: string };
  expect(eventEmbed(first, first.url).title).toBe("📦 Tabfm 1.1.0 Pytorch appears on Hugging Face");
  const card = rosterEmbed(events);
  expect(card.title).toBe("📦 2 Google weight repositories appear on Hugging Face");
  expect(card.description).toContain("tabfm-1.1.0-pytorch");
  expect(card.description).toContain("tabfm-1.1.0-jax");
});
