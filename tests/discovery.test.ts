import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import {
  collectGithubDiscovery,
  collectHuggingFaceTrending,
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

const trending = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  author: id.split("/")[0],
  createdAt: "2026-09-08T11:00:00.000Z",
  likes: 800,
  pipeline_tag: "text-generation",
  tags: ["license:apache-2.0"],
  private: false,
  safetensors: { total: 35_107_181_936 },
  ...extra,
});

test("Hugging Face trending keeps young original models and says what licence they carry", async () => {
  let requested = "";
  const request = async (url: string) => {
    requested = url;
    return Response.json([trending("nex-agi/Nex-N2.5-mini", { config: { architectures: ["NexForCausalLM"] } })]);
  };
  const collection = await collectHuggingFaceTrending(config, request, undefined, now);
  expect(requested).toContain("sort=trendingScore");
  expect(collection).toMatchObject({ source: "discovery:huggingface-trending", stream: "weights", appendOnly: true });
  expect(collection.records).toEqual([
    {
      id: "nex-agi/Nex-N2.5-mini",
      name: "nex-agi/Nex-N2.5-mini",
      url: "https://huggingface.co/nex-agi/Nex-N2.5-mini",
      author: "nex-agi",
      created: "2026-09-08T11:00:00.000Z",
      pipelineTag: "text-generation",
      license: "apache-2.0",
      parameters: 35_107_181_936,
      architecture: "NexForCausalLM",
      access: "open",
      likes: 800,
    },
  ]);
  await expect(collectHuggingFaceTrending(config, async () => Response.json({}), undefined, now)).rejects.toThrow();
});

test("copies and rediscoveries never enter the trending list", async () => {
  // Every one of these was in the top hundred on 2026-09-16.
  const request = async () =>
    Response.json([
      trending("unsloth/Qwen3.8-27B-GGUF"),
      trending("dealignai/GLM-5.3-CYBERSECURITY-FP8"),
      trending("audnai/penclaw-GLM-5.3-abliterated"),
      trending("nvidia/Qwen3.8-27B-NVFP4"),
      trending("ukisai/Swift-Qwen3.8-27b", { cardData: { base_model: "Qwen/Qwen3.8-27B" } }),
      trending("TokenRhythm/NeoHorse-1-4B", { tags: ["base_model:finetune:Qwen/Qwen3-4B"] }),
      trending("openai-community/gpt2", { createdAt: "2022-03-02T23:29:04.000Z" }),
      trending("someone/private-model", { private: true }),
      trending("openbmb/MiniCPM5-2B"),
    ]);
  const collection = await collectHuggingFaceTrending(config, request, undefined, now);
  expect(collection.records.map((record) => record.id)).toEqual(["openbmb/MiniCPM5-2B"]);
});

test("a GitHub search that ran out of time is a failed read, not the ranking", async () => {
  const request = async () => Response.json({ total_count: 500, incomplete_results: true, items: [] });
  await expect(
    collectGithubDiscovery(config, GITHUB_DISCOVERY_QUERIES[0], request, new Date("2026-09-10T12:00:00.000Z")),
  ).rejects.toThrow("incomplete results");
});
