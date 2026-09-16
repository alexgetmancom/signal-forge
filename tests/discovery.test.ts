import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import {
  collectGithubDiscovery,
  collectHuggingFaceDiscovery,
  GITHUB_DISCOVERY_QUERIES,
} from "../src/sources/discovery.js";

const config = loadConfig({
  CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname,
  GITHUB_TOKEN: "github-test-token",
});
const now = new Date("2026-09-10T12:00:00.000Z");

test("GitHub discovery builds a rolling UTC query and captures candidate attention", async () => {
  let requested = "";
  const request = async (url: string, init?: RequestInit) => {
    requested = url;
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer github-test-token");
    return Response.json({
      total_count: 1,
      incomplete_results: false,
      items: [
        {
          full_name: "openai/secret-agent",
          name: "secret-agent",
          html_url: "https://github.com/openai/secret-agent",
          owner: { login: "openai" },
          description: "An inference agent",
          created_at: "2026-09-10T10:00:00.000Z",
          updated_at: "2026-09-10T11:00:00.000Z",
          stargazers_count: 50,
          forks_count: 3,
          language: "TypeScript",
          topics: ["artificial-intelligence", "agent"],
          fork: false,
          archived: false,
        },
      ],
    });
  };

  const collection = await collectGithubDiscovery(config, GITHUB_DISCOVERY_QUERIES[0], request, now);
  const query = new URL(requested).searchParams.get("q");
  expect(query).toBe("topic:artificial-intelligence created:>2026-09-03 stars:>20 fork:false archived:false");
  expect(collection).toMatchObject({
    source: "discovery:github-ai",
    stream: "github",
    appendOnly: true,
  });
  expect(collection.trackChanges).toBeUndefined();
  expect(collection.records[0]).toMatchObject({
    id: "openai/secret-agent",
    name: "openai/secret-agent",
    owner: "openai",
    stars: 50,
    forks: 3,
    query,
    discoveryStatus: "candidate",
  });
  expect(collection.records[0]?.attentionScore).toBeGreaterThan(0);
  expect(collection.records[0]?.attentionReasons).toContain("ai-keyword-match");
});

test("GitHub discovery requires a token and rejects malformed responses", async () => {
  const noToken = { ...config, GITHUB_TOKEN: undefined };
  await expect(
    collectGithubDiscovery(noToken, GITHUB_DISCOVERY_QUERIES[1], async () => Response.json({}), now),
  ).rejects.toThrow("GITHUB_TOKEN is required");
  await expect(
    collectGithubDiscovery(config, GITHUB_DISCOVERY_QUERIES[1], async () => Response.json({}), now),
  ).rejects.toThrow();
});

test("global Hugging Face discovery sweeps a window and validates the public response", async () => {
  const requested: string[] = [];
  const request = async (url: string) => {
    requested.push(url);
    return Response.json([
      {
        id: "openai/secret-model",
        author: "openai",
        createdAt: "2026-09-10T11:00:00.000Z",
        lastModified: "2026-09-10T11:30:00.000Z",
        downloads: 10_000,
        likes: 20,
        pipeline_tag: "text-generation",
        tags: ["transformers"],
        private: false,
        gated: false,
      },
    ]);
  };
  const collection = await collectHuggingFaceDiscovery(config, request, undefined, now);
  expect(requested[0]).toContain("limit=1000");
  expect(requested[0]).toContain("expand[]=safetensors");
  // A short page is the end of the feed: one request, not twenty-four.
  expect(requested).toHaveLength(1);
  expect(collection).toMatchObject({ source: "discovery:huggingface-recent", stream: "weights", appendOnly: true });
  expect(collection.records[0]).toMatchObject({ id: "openai/secret-model", author: "openai" });
  await expect(collectHuggingFaceDiscovery(config, async () => Response.json({}), undefined, now)).rejects.toThrow();
});

test("a body carries the parameter count but never a figure that moves", async () => {
  const request = async () =>
    Response.json([
      {
        id: "lab/new-weights",
        author: "lab",
        createdAt: "2026-09-10T11:00:00.000Z",
        lastModified: "2026-09-10T23:00:00.000Z",
        downloads: 4,
        likes: 3,
        tags: [],
        private: false,
        safetensors: { total: 753_329_940_480 },
      },
    ]);
  const record = (await collectHuggingFaceDiscovery(config, request, undefined, now)).records[0];
  expect(record).toMatchObject({ parameters: 753_329_940_480, derivative: false });
  expect(record).not.toHaveProperty("likes");
  expect(record).not.toHaveProperty("downloads");
  expect(record).not.toHaveProperty("updated");
});

test("likes find what the parameter rule cannot, and only while the model is young", async () => {
  const liked = (createdAt: string) => ({
    id: "gated/model",
    author: "gated",
    createdAt,
    tags: [],
    private: false,
    likes: 40,
    gated: true,
  });
  const reasons = async (createdAt: string) =>
    (await collectHuggingFaceDiscovery(config, async () => Response.json([liked(createdAt)]), undefined, now))
      .records[0]?.notableReasons;
  expect(await reasons("2026-09-10T11:00:00.000Z")).toEqual(["likes-within-12h"]);
  // Past the window the model is not read at all: the like count it carries was earned out of
  // sight, and the sweep cannot page back far enough to have watched it happen.
  expect(await reasons("2026-09-09T11:00:00.000Z")).toBeUndefined();
});

test("a model served again on the next page is one model, not a rejected sweep", async () => {
  // `skip` counts from the newest model at each request, so a model published between two pages
  // repeats the last row of one as the first of the next. On 2026-09-16 that rejected a whole sweep.
  const model = (id: string, createdAt: string) => ({
    id,
    author: "lab",
    createdAt,
    lastModified: createdAt,
    downloads: 0,
    likes: 0,
    pipeline_tag: "text-generation",
    tags: [],
    private: false,
    gated: false,
  });
  const full = Array.from({ length: 1000 }, (_, index) =>
    model(`lab/model-${index}`, new Date(Date.parse("2026-09-10T11:00:00.000Z") - index * 1000).toISOString()),
  );
  const pages = [full, [full[999], model("lab/older", "2026-09-10T08:00:00.000Z")]];
  let call = 0;
  const collection = await collectHuggingFaceDiscovery(
    config,
    async () => Response.json(pages[call++]),
    undefined,
    now,
  );
  expect(call).toBe(2);
  expect(collection.records.filter((record) => record.id === "lab/model-999")).toHaveLength(1);
  expect(collection.records).toHaveLength(1001);
});
