import { expect, test } from "bun:test";
import { readerStanding } from "../src/events/confidence.js";
import { eventHeadline, eyebrow, readerImpact } from "../src/events/render/headline.js";
import type { Event } from "../src/events/types.js";
import { bundleMemory } from "../src/sources/bundleMemory.js";
import { claudeCodeUnchanged } from "../src/sources/claudeCode.js";
import { openDatabase } from "../src/storage/database.js";

const sighting: Event = {
  id: 1,
  source: "claude-code-models",
  stream: "github",
  entity_id: "claude-sonnet-5-5",
  kind: "new",
  before_json: null,
  after_json: JSON.stringify({ id: "claude-sonnet-5-5", name: "claude-sonnet-5-5", maker: "Anthropic" }),
  detected_at: "2026-09-28T17:23:40.535Z",
  confidence: "observed",
  evidence_type: "binary_string",
  authority: "vendor_owned",
  signal: "codename",
};

test("a name compiled into a shipped binary is described as one, and said once", () => {
  // `claude-sonnet-5-5` went out on 2026-09-28 reading "From the project's repository. Work in
  // progress, not a release. Repository activity is not a release." -- the repository sentence
  // twice, over a source that reads no repository. Both lines came from the evidence type it had
  // borrowed for want of one of its own.
  expect(readerStanding(sighting)).toBe("Compiled into a shipped binary. Not announced, and not callable yet.");
  expect(readerImpact(sighting, null)).toBeNull();
  // Found, not launched: 🆕 is the icon of a catalogue listing something a reader can go and call.
  expect(eventHeadline(sighting, "claude-sonnet-5-5", null)).toBe("🔎 Claude Sonnet 5.5");
  // The banner is the part of the card that gets screenshotted, and it said REPOSITORY.
  expect(eyebrow(sighting)).toBe("SHIPPED BINARY");
});

test("a commit still reads as a commit: the repository sentence keeps its own events", () => {
  const commit: Event = { ...sighting, source: "github:openai/codex:models", evidence_type: "github_activity" };
  expect(readerImpact(commit, null)).toBe("Repository activity is not a release.");
  expect(eyebrow(commit)).toBe("REPOSITORY");
});

test("the published version is asked for without downloading the build behind it", async () => {
  const db = openDatabase(":memory:");
  const asked: string[] = [];
  const request = async (url: string | URL | Request) => {
    asked.push(String(url));
    return Response.json({ next: "2.1.284", latest: "2.1.283" });
  };

  // Nothing read yet, so there is something to do and the poller must not skip the collection.
  expect(await claudeCodeUnchanged(request, bundleMemory(db, "claude-code-models"))).toBe(false);

  db.query("INSERT INTO app_state(key,value) VALUES(?,?)").run("bundle-version:claude-code-models", "2.1.284");
  db.query("INSERT INTO records(source,id,body,stream,observed_at) VALUES(?,?,?,?,?)").run(
    "claude-code-models",
    "claude-sonnet-5-5",
    JSON.stringify({ id: "claude-sonnet-5-5" }),
    "github",
    "2026-09-28T17:23:40.535Z",
  );
  expect(await claudeCodeUnchanged(request, bundleMemory(db, "claude-code-models"))).toBe(true);

  // `next` before `latest`: the channel a model id arrives on is the one that matters here, and
  // reading `latest` would have called 2.1.284 unread for as long as it stayed on `next`.
  expect(asked.every((url) => url.endsWith("/dist-tags"))).toBe(true);
  db.close();
});

test("a tarball that 404s minutes after its dist-tag moved is a publish race, not a failed source", async () => {
  const { collectClaudeCodeModels } = await import("../src/sources/claudeCode.js");
  const db = openDatabase(":memory:");
  const memory = bundleMemory(db, "claude-code-models");
  db.query("INSERT INTO app_state(key,value) VALUES(?,?)").run("bundle-version:claude-code-models", "2.1.292");
  for (const id of ["claude-haiku-5", "claude-opus-5", "claude-sonnet-5"])
    db.query("INSERT INTO records(source,id,body,stream,observed_at) VALUES(?,?,?,?,?)").run(
      "claude-code-models",
      id,
      JSON.stringify({ id }),
      "github",
      "2026-10-06T17:16:48.849Z",
    );

  // npm moved `next` to 2.1.293 before the platform package served the tarball behind it. This is
  // what production did twice on 2026-10-07, and each 404 doubled the wait before the newest
  // release of all would be read.
  const request = async (url: string | URL | Request) =>
    String(url).endsWith("/dist-tags")
      ? Response.json({ next: "2.1.293", latest: "2.1.292" })
      : new Response("", { status: 404 });

  const collection = await collectClaudeCodeModels(request, memory);
  expect(collection.records.map((record) => record.id)).toEqual(["claude-haiku-5", "claude-opus-5", "claude-sonnet-5"]);
  // Answered with the version actually read through, never with the one that would not download.
  expect(collection.url).toEndWith("/v/2.1.292");
  // And not remembered, so the next poll downloads 2.1.293 rather than skipping it as read.
  expect(memory.lastVersion()).toBe("2.1.292");

  db.close();
});

test("a tarball still missing after a publish takes is a failure again", async () => {
  const { collectClaudeCodeModels } = await import("../src/sources/claudeCode.js");
  const { PUBLISH_RACE_MS } = await import("../src/sources/bundleMemory.js");
  const db = openDatabase(":memory:");
  db.query("INSERT INTO app_state(key,value) VALUES(?,?)").run("bundle-version:claude-code-models", "2.1.292");
  db.query("INSERT INTO records(source,id,body,stream,observed_at) VALUES(?,?,?,?,?)").run(
    "claude-code-models",
    "claude-opus-5",
    JSON.stringify({ id: "claude-opus-5" }),
    "github",
    "2026-10-06T17:16:48.849Z",
  );
  // The window opened longer ago than a publish takes, so this is a package that has moved or been
  // renamed. Tolerating it any further would serve last week's names under a healthy source.
  const opened = new Date(Date.now() - PUBLISH_RACE_MS - 60_000).toISOString();
  db.query("INSERT INTO app_state(key,value) VALUES(?,?)").run(
    "bundle-pending:claude-code-models",
    JSON.stringify(["2.1.293", opened]),
  );

  const request = async (url: string | URL | Request) =>
    String(url).endsWith("/dist-tags")
      ? Response.json({ next: "2.1.293", latest: "2.1.292" })
      : new Response("", { status: 404 });

  await expect(collectClaudeCodeModels(request, bundleMemory(db, "claude-code-models"))).rejects.toThrow("HTTP 404");
  db.close();
});
