import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import type { Fetch } from "../src/http-client.js";
import { listPublications, syncPublications } from "../src/publications.js";
import { openDatabase } from "../src/storage/database.js";

const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
const config = () =>
  loadConfig({
    CONFIG_PATH: configPath,
    SOLO_PUBLISHER_MCP_URL: "https://studio.example/api/mcp",
    SOLO_PUBLISHER_MCP_TOKEN: "private-studio-token",
  });
const post = (id: number) => ({
  ref: `post:${id}`,
  postId: id,
  at: "2026-09-12T10:00:00+03:00",
  status: "published",
  headline: "Limits reset",
  targets: [{ target: "telegram", status: "published", url: `https://t.me/example/${id}`, partial: false }],
});
function studio(
  rows: ReturnType<typeof post>[],
  text = "Source: https://example.com/announcement",
  brokenRef?: string,
): Fetch {
  return async (_url, init) => {
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-studio-token");
    const body = JSON.parse(String(init?.body));
    expect(["ops_recent", "ops_post_text"]).toContain(body.params.name);
    const ref = body.params.arguments.ref;
    const result =
      body.params.name === "ops_recent"
        ? { posts: rows }
        : { ref: brokenRef ?? ref, postId: Number(ref.split(":")[1]), at: rows[0]?.at, ru: text, en: null };
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result: { content: [{ type: "text", text: JSON.stringify(result) }] },
    });
  };
}

test("sync retains full copy and delivery outcomes without evidence or delivery side effects; retries update in place", async () => {
  const db = openDatabase(":memory:");
  try {
    await syncPublications(db, config(), studio([post(1), post(2)]));
    await syncPublications(db, config(), studio([post(2)], "Edited copy"));
    const report = listPublications(db, config());
    expect(report.total).toBe(2);
    expect(report.publications[0]?.textRu).toBe("Edited copy");
    expect(report.publications[0]?.publishedAt).toBe("2026-09-12T07:00:00.000Z");
    expect(report.publications[0]?.targets[0]?.url).toBe("https://t.me/example/2");
    for (const table of ["events", "snapshots", "deliveries"])
      expect(db.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});

test("empty, mismatched and malformed responses preserve the last complete sync and never expose secrets", async () => {
  const db = openDatabase(":memory:");
  try {
    await syncPublications(db, config(), studio([post(1)]));
    const before = listPublications(db, config());
    await expect(syncPublications(db, config(), studio([]))).rejects.toThrow("unexpected empty");
    await expect(syncPublications(db, config(), studio([post(2)], "Wrong", "post:3"))).rejects.toThrow(
      "different post",
    );
    await expect(
      syncPublications(db, config(), async () => {
        throw new Error("private-studio-token");
      }),
    ).rejects.toThrow("could not be validated");
    await expect(syncPublications(db, config(), async () => Response.json({ posts: [] }))).rejects.toThrow(
      "could not be validated",
    );
    expect(listPublications(db, config())).toEqual(before);
  } finally {
    db.close();
  }
});

test("a lost window overlap stays visible after subsequent successful reads", async () => {
  const db = openDatabase(":memory:");
  try {
    await syncPublications(db, config(), studio([post(1)]));
    const next = Array.from({ length: 50 }, (_, i) => post(i + 2));
    await expect(syncPublications(db, config(), studio(next))).rejects.toThrow("coverage has a gap");
    expect(listPublications(db, config()).total).toBe(51);
    await expect(syncPublications(db, config(), studio(next))).rejects.toThrow("coverage has a gap");
    expect(listPublications(db, config()).gapDetected).toBe(true);
  } finally {
    db.close();
  }
});

test("a partial text read cannot commit half a window", async () => {
  const db = openDatabase(":memory:");
  const request = studio([post(1), post(2)]);
  try {
    let calls = 0;
    await expect(
      syncPublications(db, config(), async (url, init) => {
        if (++calls === 3) return Response.json({ error: "unavailable" }, { status: 503 });
        return request(url, init);
      }),
    ).rejects.toThrow("could not be validated");
    expect(listPublications(db, config()).total).toBe(0);
    expect(listPublications(db, config()).checkedAt).toBeNull();
  } finally {
    db.close();
  }
});

test("Studio configuration requires paired credentials and rejects credential-bearing URLs", () => {
  expect(() => loadConfig({ CONFIG_PATH: configPath, SOLO_PUBLISHER_MCP_TOKEN: "token" })).toThrow(
    "configured together",
  );
  for (const url of [
    "http://studio.example/api/mcp",
    "https://user:secret@studio.example/api/mcp",
    "https://studio.example/api/mcp?token=secret",
  ]) {
    expect(() =>
      loadConfig({ CONFIG_PATH: configPath, SOLO_PUBLISHER_MCP_URL: url, SOLO_PUBLISHER_MCP_TOKEN: "token" }),
    ).toThrow();
  }
});
