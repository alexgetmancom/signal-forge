import { expect, test } from "bun:test";
import { bundleModelIds, CLI_BUNDLES } from "../src/sources/cliBundles.js";

test("a client's bundle names its models and not its fixtures", () => {
  const gemini = CLI_BUNDLES.find((bundle) => bundle.source === "gemini-cli-models");
  if (!gemini) throw new Error("the Gemini CLI bundle is gone");
  const text = '"gemini-3.8-flash" "gemini-9001-super-duper" "gemini-3-flash-base" "gemini-3.1-pro-preview"';
  expect(bundleModelIds(text, gemini.pattern)).toEqual(["gemini-3.1-pro-preview", "gemini-3.8-flash"]);
});

test("a bundle is read in pieces, and an id written across the join between two is still found", async () => {
  const { collectCliBundle } = await import("../src/sources/cliBundles.js");
  const gemini = CLI_BUNDLES.find((bundle) => bundle.source === "gemini-cli-models");
  if (!gemini) throw new Error("the Gemini CLI bundle is gone");

  // The decompressor hands its output back in 16 KB pieces, so two of these names are written across
  // a join on purpose: one straddling the first, one straddling the second. Before the tail of each
  // piece was carried into the next, both were missed -- and a bundle naming four models instead of
  // six passes its floor and says nothing about what it lost.
  const names = [
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-pro-preview",
    "gemini-3-pro",
    "gemini-2.5-flash",
    "gemini-3.1-flash-live-preview",
  ];
  const bytes = Buffer.alloc(49_152, "x");
  const write = (name: string, at: number) => bytes.write(`"${name}"`, at, "latin1");
  write(names[0] as string, 16_384 - 9);
  write(names[1] as string, 32_768 - 4);
  for (const [index, name] of names.slice(2).entries()) write(name, 2_048 + index * 4_096);
  const gzipped = Bun.gzipSync(bytes);

  const request = async (url: string | URL | Request) =>
    String(url).endsWith("/dist-tags") ? Response.json({ latest: "1.2.3" }) : new Response(gzipped);
  const collection = await collectCliBundle(gemini, request);
  expect(collection.records.map((record) => record.id)).toEqual([...names].sort());
  expect(collection.url).toBe("https://www.npmjs.com/package/@google/gemini-cli/v/1.2.3");
});

test("a dated alias is the model it dates, not a second one", () => {
  const qwen = CLI_BUNDLES.find((bundle) => bundle.source === "qwen-code-models");
  if (!qwen) throw new Error("the Qwen Code bundle is gone");
  expect(bundleModelIds('"qwen3.8-max" "qwen3.8-max-0902" "qwen3-max-2026-01-23"', qwen.pattern)).toEqual([
    "qwen3.8-max",
  ]);
});

test("a bundle is read on the channel its vendor ships to first, not on `latest`", async () => {
  const { collectCliBundle } = await import("../src/sources/cliBundles.js");
  const gemini = CLI_BUNDLES.find((bundle) => bundle.source === "gemini-cli-models");
  if (!gemini) throw new Error("the Gemini CLI bundle is gone");

  const names = ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro", "gemini-3-pro", "gemini-2.5-flash"];
  const gzipped = Bun.gzipSync(Buffer.from(names.map((name) => `"${name}"`).join(" ")));
  const asked: string[] = [];
  const request = async (url: string | URL | Request) => {
    asked.push(String(url));
    return String(url).endsWith("/dist-tags")
      ? Response.json({ nightly: "0.65.0-nightly.20261007", preview: "0.64.0-preview.0", latest: "0.63.0" })
      : new Response(gzipped);
  };

  // `latest` was two minors behind on 2026-10-07 and this source had produced no event in a
  // fortnight of reading it. The tarball asked for is the one the leading channel names.
  const collection = await collectCliBundle(gemini, request);
  expect(collection.url).toBe("https://www.npmjs.com/package/@google/gemini-cli/v/0.65.0-nightly.20261007");
  expect(asked.some((url) => url.includes("gemini-cli-0.65.0-nightly.20261007.tgz"))).toBe(true);
});

test("a nightly that trails its own latest is not a channel this reads", () => {
  const qwen = CLI_BUNDLES.find((bundle) => bundle.source === "qwen-code-models");
  if (!qwen) throw new Error("the Qwen Code bundle is gone");
  // Reading it would walk the source onto an older bundle, where every name the newer one added
  // reads as a model that was removed.
  expect(qwen.channels).not.toContain("nightly");
});
