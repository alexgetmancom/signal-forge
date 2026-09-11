import { expect, test } from "bun:test";
import { collectModelScope, MODELSCOPE_ORGS, parseModelScope } from "../src/sources/modelscope.js";

const payload = (models: Record<string, unknown>[]) =>
  JSON.stringify({ Code: 200, Data: { Model: { Models: models } }, Success: true });

const model = (path: string, name: string, extra: Record<string, unknown> = {}) => ({
  Path: path,
  Name: name,
  CreatedTime: 1789011254,
  License: "mit",
  Downloads: 4083,
  Stars: 101,
  ...extra,
});

test("a watched organisation's release becomes one open-weight record", () => {
  const collection = parseModelScope(payload([model("deepseek-ai", "DeepSeek-V4.1-Flash")]));
  expect(collection.source).toBe("modelscope:recent");
  expect(collection.stream).toBe("weights");
  expect(collection.records).toEqual([
    {
      id: "deepseek-ai/DeepSeek-V4.1-Flash",
      name: "deepseek-ai: DeepSeek-V4.1-Flash",
      url: "https://modelscope.cn/models/deepseek-ai/DeepSeek-V4.1-Flash",
      maker: "deepseek-ai",
      access: "public",
      license: "mit",
      created: "2026-09-10T03:34:14.000Z",
    },
  ]);
});

test("counts that move on every poll are left out of the record", () => {
  const [record] = parseModelScope(payload([model("Qwen", "Qwen3.8-27B")])).records;
  expect(record).not.toHaveProperty("Downloads");
  expect(record).not.toHaveProperty("stars");
});

test("the rest of a large public registry stays out of the collection", () => {
  const collection = parseModelScope(
    payload([model("deepseek-ai", "DeepSeek-V4.1-Flash"), model("some-user", "my-lora-finetune")]),
  );
  expect(collection.records.map((record) => record.id)).toEqual(["deepseek-ai/DeepSeek-V4.1-Flash"]);
});

test("an empty or malformed listing is a failed read, never an empty registry", () => {
  expect(() => parseModelScope(payload([]))).toThrow("no models");
  expect(() => parseModelScope(JSON.stringify({ Code: 200, Data: {} }))).toThrow();
  expect(() => parseModelScope("<html>blocked</html>")).toThrow();
});

test("the collector asks the catalogue endpoint with its filter body", async () => {
  let seen: { url: string; method?: string | undefined; body?: unknown } = { url: "" };
  await collectModelScope(async (url, init) => {
    seen = { url: String(url), method: init?.method, body: init?.body };
    return new Response(payload([model("Qwen", "Qwen3.8-Flash-Next")]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  expect(seen.url).toBe("https://modelscope.cn/api/v1/dolphin/models");
  expect(seen.method).toBe("PUT");
  expect(String(seen.body)).toContain('"SortBy":"Default"');
  expect(MODELSCOPE_ORGS).toContain("Qwen");
});
