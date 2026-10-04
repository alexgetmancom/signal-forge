import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { SourceError } from "../src/failure.js";
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

const repository = {
  nameWithOwner: "openai/secret-agent",
  url: "https://github.com/openai/secret-agent",
  owner: { login: "openai" },
  description: "An inference agent",
  createdAt: "2026-09-10T10:00:00.000Z",
  updatedAt: "2026-09-10T11:00:00.000Z",
  stargazerCount: 50,
  forkCount: 3,
  primaryLanguage: { name: "TypeScript" },
  repositoryTopics: { nodes: [{ topic: { name: "artificial-intelligence" } }, { topic: { name: "agent" } }] },
  isFork: false,
  isArchived: false,
};

function searchPage(nodes: unknown[], repositoryCount = nodes.length) {
  return { data: { search: { repositoryCount, pageInfo: { hasNextPage: repositoryCount > 100 }, nodes } } };
}

test("GitHub discovery builds a rolling UTC query and captures candidate attention", async () => {
  let requested = "";
  let submitted: { query: string; variables: { query: string } } | undefined;
  const request = async (url: string, init?: RequestInit) => {
    requested = url;
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer github-test-token");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(init?.method).toBe("POST");
    submitted = JSON.parse(String(init?.body));
    return Response.json(searchPage([repository]));
  };

  const collection = await collectGithubDiscovery(config, GITHUB_DISCOVERY_QUERIES[0], request, now);
  expect(requested).toBe("https://api.github.com/graphql");
  const query = new URL(collection.url).searchParams.get("q");
  expect(query).toBe("topic:artificial-intelligence created:>2026-09-03 stars:>20 fork:false archived:false");
  expect(submitted?.variables.query).toBe(`${query} sort:created-desc`);
  expect(submitted?.query).toContain("type: REPOSITORY, first: 100");
  expect(submitted?.query).toContain("repositoryTopics(first: 100)");
  expect(collection).toMatchObject({
    source: "discovery:github-ai",
    stream: "github",
  });
  expect(collection.trackChanges).toBeUndefined();
  expect(collection.records[0]).toMatchObject({
    id: "openai/secret-agent",
    name: "openai/secret-agent",
    url: "https://github.com/openai/secret-agent",
    owner: "openai",
    description: "An inference agent",
    created: "2026-09-10T10:00:00.000Z",
    updated: "2026-09-10T11:00:00.000Z",
    stars: 50,
    forks: 3,
    language: "TypeScript",
    topics: ["agent", "artificial-intelligence"],
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
  expect(collection).toMatchObject({ source: "discovery:huggingface-trending", stream: "weights" });
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

test("GitHub rejects GraphQL errors even with HTTP 200 and otherwise valid partial data", async () => {
  const upstream = "private upstream text must not reach the reader";
  for (const data of [searchPage([repository]).data, null]) {
    const request = async () => Response.json({ data, errors: [{ message: upstream, path: [upstream] }] });
    const error = await collectGithubDiscovery(config, GITHUB_DISCOVERY_QUERIES[0], request, now).catch((e) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect(error.kind).toBe("protocol");
    expect(error.message).toBe("GitHub search returned incomplete results");
    expect(JSON.stringify(error)).not.toContain(upstream);
  }
});

test("GitHub refuses a short page or a missing node instead of accepting a partial search", async () => {
  for (const response of [searchPage([repository], 2), searchPage([], 120), searchPage([null])]) {
    await expect(
      collectGithubDiscovery(config, GITHUB_DISCOVERY_QUERIES[0], async () => Response.json(response), now),
    ).rejects.toThrow();
  }
});

test("GitHub keeps the newest hundred results when the complete first page has more behind it", async () => {
  const nodes = Array.from({ length: 100 }, (_, i) => ({ ...repository, nameWithOwner: `openai/agent-${i}` }));
  const collection = await collectGithubDiscovery(
    config,
    GITHUB_DISCOVERY_QUERIES[2],
    async () => Response.json(searchPage(nodes, 195)),
    now,
  );
  expect(collection.records.map((record) => record.id)).toEqual(nodes.map((node) => node.nameWithOwner));
  const empty = await collectGithubDiscovery(
    config,
    GITHUB_DISCOVERY_QUERIES[3],
    async () => Response.json(searchPage([])),
    now,
  );
  expect(empty.records).toEqual([]);
});

test("GitHub preserves repositories without a description, language or topics and filters forks and archives", async () => {
  const collection = await collectGithubDiscovery(
    config,
    GITHUB_DISCOVERY_QUERIES[1],
    async () =>
      Response.json(
        searchPage([
          { ...repository, description: null, primaryLanguage: null, repositoryTopics: { nodes: [] } },
          { ...repository, nameWithOwner: "openai/fork", isFork: true },
          { ...repository, nameWithOwner: "openai/archive", isArchived: true },
        ]),
      ),
    now,
  );
  expect(collection.records).toHaveLength(1);
  expect(collection.records[0]).toMatchObject({
    id: repository.nameWithOwner,
    description: null,
    language: null,
    topics: [],
  });
});
