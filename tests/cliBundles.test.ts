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
