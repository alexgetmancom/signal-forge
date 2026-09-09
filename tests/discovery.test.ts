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

test("global Hugging Face discovery is append-only and validates the public response", async () => {
  let requested = "";
  const request = async (url: string) => {
    requested = url;
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
  expect(requested).toBe("https://huggingface.co/api/models?sort=createdAt&direction=-1&limit=100");
  expect(collection).toMatchObject({ source: "discovery:huggingface-recent", stream: "weights", appendOnly: true });
  expect(collection.records[0]).toMatchObject({
    id: "openai/secret-model",
    author: "openai",
    pipelineTag: "text-generation",
    discoveryStatus: "candidate",
  });
  expect(collection.records[0]?.attentionScore).toBeGreaterThan(0);
  await expect(collectHuggingFaceDiscovery(config, async () => Response.json({}), undefined, now)).rejects.toThrow();
});
