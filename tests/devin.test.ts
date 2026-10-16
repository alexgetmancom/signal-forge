import { expect, test } from "bun:test";
import { collectDevinModels, devinModelIds } from "../src/sources/devin.js";

/**
 * The bytes at offset 138276752 of `devin` 3000.11.92-linux-x64, read 2026-10-16: three codenames
 * whose `-eap` is cut by the sixteen-byte slot they sit in, two written whole, and the versioned
 * ids packed against them with no separator anywhere.
 */
const TABLE =
  "Layoutalign\0\0\0\0\0claude-opus-5-5-claude-vanilla-eap\0\0\0\0\0" +
  "claude-verrine-eclaude-onigiri-eclaude-orzata-eap\0\0\0claude-odango-ea" +
  "claude-fable-5-1claude-haiku-5-5Claude 5.5 Haikuclaude-haiku-4-5";

test("a codename is read without its channel, however the string table cut it", () => {
  expect(devinModelIds(TABLE).codenames).toEqual([
    "claude-odango",
    "claude-onigiri",
    "claude-orzata",
    "claude-vanilla",
    "claude-verrine",
  ]);
});

test("a versioned id is read whole and its routing knobs are not part of it", () => {
  const text = "claude-opus-5-5-xhigh-priority-usaclaude-opus-5-5-max-fastclaude-sonnet-4-20250514";
  expect(devinModelIds(text).versioned).toEqual(["claude-opus-5-5", "claude-sonnet-4"]);
});

test("a build naming too few versioned ids is a read that found the wrong file", async () => {
  const gzipped = Bun.gzipSync(Buffer.from("claude-opus-5-5claude-vanilla-eap\0"));
  const request = async (url: string | URL | Request) =>
    String(url).endsWith("/dist-tags") ? Response.json({ "linux-x64": "1-linux-x64" }) : new Response(gzipped);
  expect(collectDevinModels(request)).rejects.toThrow(/names 1 versioned models/);
});

test("the build is read on its platform tag, and codenames are stored beside the versions", async () => {
  const names = [
    "claude-opus-4-5",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-opus-5-5",
    "claude-sonnet-4-5",
    "claude-sonnet-4-6",
    "claude-sonnet-5",
    "claude-haiku-5-5",
  ];
  const gzipped = Bun.gzipSync(Buffer.from(`${names.join("")}claude-vanilla-eap\0`));
  const asked: string[] = [];
  const request = async (url: string | URL | Request) => {
    asked.push(String(url));
    return String(url).endsWith("/dist-tags")
      ? Response.json({ latest: "3000.11.92", "linux-x64": "3000.11.92-linux-x64" })
      : new Response(gzipped);
  };
  const collection = await collectDevinModels(request);
  expect(collection.records.map((record) => record.id)).toEqual([...names, "claude-vanilla"].sort());
  expect(collection.records.every((record) => record.maker === "Anthropic")).toBe(true);
  expect(asked.at(-1)).toBe("https://registry.npmjs.org/devin/-/devin-3000.11.92-linux-x64.tgz");
  expect(collection.url).toBe("https://www.npmjs.com/package/devin/v/3000.11.92-linux-x64");
});
