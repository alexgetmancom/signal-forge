import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import type { Event } from "../src/events/types.js";
import { packageReleaseNotes } from "../src/sources/packageNotes.js";

const config = { ...loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname }) };

const bump = (source: string, version: string): Event =>
  ({
    id: 1,
    source,
    stream: "packages",
    entity_id: "latest",
    kind: "changed",
    detected_at: "2026-09-11T10:00:00.000Z",
    before_json: JSON.stringify({ id: "latest", version: "0.153.0" }),
    after_json: JSON.stringify({ id: "latest", version }),
  }) as Event;

// Tag spellings differ between projects; the version has to be found inside the tag.
const payload = JSON.stringify([
  { tag_name: "rust-v0.154.0", body: "## New Features\n- GPT-6-Astra is now available in the model picker" },
  { tag_name: "rust-v0.153.0", body: "Older release" },
]);

test("a version bump is answered with what that version actually contained", async () => {
  const notes = await packageReleaseNotes(bump("npm:@openai/codex", "0.154.0"), config, async (url) => {
    expect(String(url)).toBe("https://api.github.com/repos/openai/codex/releases?per_page=30");
    return new Response(payload);
  });
  expect(notes).toContain("GPT-6-Astra");
  expect(notes).toContain("rust-v0.154.0");
});

test("a package nobody mapped to a repository asks nothing of GitHub", async () => {
  const notes = await packageReleaseNotes(bump("npm:@some/other", "1.0.0"), config, async () => {
    throw new Error("must not request");
  });
  expect(notes).toBeNull();
});

test("a version with no matching release leaves the bump as it was", async () => {
  const notes = await packageReleaseNotes(
    bump("npm:@openai/codex", "0.999.0"),
    config,
    async () => new Response(payload),
  );
  expect(notes).toBeNull();
});

test("a draft release is not a release", async () => {
  const notes = await packageReleaseNotes(
    bump("npm:@openai/codex", "0.154.0"),
    config,
    async () => new Response(JSON.stringify([{ tag_name: "rust-v0.154.0", body: "unpublished", draft: true }])),
  );
  expect(notes).toBeNull();
});
