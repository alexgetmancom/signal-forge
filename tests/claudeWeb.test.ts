import { expect, test } from "bun:test";
import { selectMeaningfulWebStrings } from "../src/events/web.js";
import { collectClaude, extractStrings } from "../src/sources/claude.js";
import { openDatabase } from "../src/storage/database.js";
import { HttpCache } from "../src/storage/httpCache.js";

test("Claude retains strings per asset, traverses two levels once, and reuses immutable bundles", async () => {
  const db = openDatabase(":memory:");
  const cache = new HttpCache(db);
  const entry = "https://assets-proxy.anthropic.com/claude-ai/app/main.js";
  const one = "https://assets-proxy.anthropic.com/claude-ai/app/chunks/one.js";
  const empty = "https://assets-proxy.anthropic.com/claude-ai/app/chunks/empty.js";
  const two = "https://assets-proxy.anthropic.com/claude-ai/app/chunks/two.js";
  const assets: Record<string, string> = {
    [entry]:
      'import {x} from "./chunks/one.js";import("./chunks/empty.js");{defaultMessage:"Use Claude Opus 6 for your project"}',
    [one]:
      'import {x} from "./two.js";import {y} from "../main.js";{defaultMessage:"Connect your calendar with a Claude connector"}',
    [empty]: `const unused=${JSON.stringify("Unobserved implementation code ".repeat(3000))};`,
    [two]:
      'import {x} from "./third.js";{defaultMessage:"Use Claude Opus 6 for your project"};{defaultMessage:"中文工具"}',
  };
  const asked: string[] = [];
  const request = async (url: string) => {
    asked.push(url);
    if (url === "https://claude.ai") return new Response(`<script src="${entry}"></script>`);
    if (!(url in assets)) throw new Error("Unobserved asset requested");
    return new Response(assets[url], { headers: { "cache-control": "public, max-age=31536000, immutable" } });
  };
  const first = await collectClaude(request, cache);
  expect(asked).toEqual(["https://claude.ai", entry, one, empty, two]);
  expect(first.records).toEqual([
    {
      id: "public-entry-strings",
      name: "Claude: public interface strings",
      strings: selectMeaningfulWebStrings(Object.values(assets).flatMap(extractStrings)),
    },
  ]);
  expect(first.raw).toEqual(
    Object.fromEntries(Object.entries(assets).map(([url, code]) => [url, extractStrings(code)])),
  );
  expect(JSON.stringify(first.raw).length).toBeLessThan(1000);
  const again = await collectClaude(request, cache);
  expect(again).toEqual(first);
  expect(asked).toEqual(["https://claude.ai", entry, one, empty, two, "https://claude.ai"]);
  db.close();
});

test("a refused bundle waits for sibling reads and aborts instead of accepting partial strings", async () => {
  const entry = "https://assets-proxy.anthropic.com/claude-ai/app/main.js";
  let siblingRead = false;
  const request = async (url: string) => {
    if (url === "https://claude.ai") return new Response(`<script src="${entry}"></script>`);
    if (url === entry)
      return new Response(
        'import {x} from "./missing.js";import {y} from "./slow.js";{defaultMessage:"Use Claude Opus 6 for your project"}',
      );
    if (url.endsWith("/slow.js")) {
      await Bun.sleep(5);
      siblingRead = true;
      return new Response('{defaultMessage:"Connect your calendar with a Claude connector"}');
    }
    return new Response(null, { status: 403 });
  };
  await expect(collectClaude(request)).rejects.toMatchObject({ status: 403 });
  expect(siblingRead).toBe(true);
});

test("an oversized entry graph is refused before any of its chunks are downloaded", async () => {
  const entry = "https://assets-proxy.anthropic.com/claude-ai/app/main.js";
  const asked: string[] = [];
  const request = async (url: string) => {
    asked.push(url);
    if (url === "https://claude.ai") return new Response(`<script src="${entry}"></script>`);
    return new Response(
      Array.from({ length: 1200 }, (_, index) => `import {x${index}} from "./chunk-${index}.js";`).join(""),
    );
  };
  await expect(collectClaude(request)).rejects.toMatchObject({ kind: "protocol" });
  expect(asked).toEqual(["https://claude.ai", entry]);
});
