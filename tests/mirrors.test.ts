import { expect, test } from "bun:test";
import {
  bareModelSlug,
  collectModelsDev,
  collectTrueFoundryAzure,
  providerVersionBase,
} from "../src/sources/mirrors.js";

test("one model written six ways normalises to one slug", () => {
  expect(bareModelSlug("anthropic/claude-opus-5")).toBe("claude-opus-5");
  expect(bareModelSlug("us.anthropic.claude-opus-5-v1:0")).toBe("claude-opus-5");
  expect(bareModelSlug("global.anthropic.claude-fable-5-1")).toBe("claude-fable-5-1");
  expect(bareModelSlug("claude-opus-5@default")).toBe("claude-opus-5");
  expect(bareModelSlug("anthropic-claude-opus-5")).toBe("claude-opus-5");
});

test("a maker's name inside a model's own name is not a prefix to strip", () => {
  expect(bareModelSlug("mistral-large-2411")).toBe("mistral-large-2411");
  expect(bareModelSlug("deepseek-chat")).toBe("deepseek-chat");
  expect(bareModelSlug("mistralai/mistral-small-4")).toBe("mistral-small-4");
});

/**
 * The four version artifacts and the three lookalikes, as the TrueFoundry tree held them on
 * 2026-09-15. `claude-opus-4-5` is the case the suffix alone gets wrong.
 */
const tree = new Map<string, ReadonlySet<string>>([
  ["claude-opus-5", new Set(["anthropic", "aws-bedrock", "azure-ai-foundry", "microsoft-foundry"])],
  ["claude-opus-5-2", new Set(["azure-ai-foundry", "microsoft-foundry"])],
  ["claude-haiku-4-5", new Set(["anthropic", "azure-ai-foundry", "microsoft-foundry"])],
  ["claude-haiku-4-5-2", new Set(["azure-ai-foundry", "microsoft-foundry"])],
  ["claude-opus-4", new Set(["anthropic", "aws-bedrock"])],
  ["claude-opus-4-5", new Set(["anthropic", "aws-bedrock", "microsoft-foundry"])],
  ["claude-fable-5", new Set(["anthropic", "aws-bedrock"])],
  ["claude-fable-5-1", new Set(["anthropic", "aws-bedrock"])],
]);

test("an Azure-only numeric suffix is the deployment version of the model the vendor lists", () => {
  expect(providerVersionBase("claude-opus-5-2", tree)).toBe("claude-opus-5");
  expect(providerVersionBase("claude-haiku-4-5-2", tree)).toBe("claude-haiku-4-5");
});

test("a model the vendor lists itself is a release however its slug ends", () => {
  // Opus 4.5 ends in a digit and Opus 4 exists beside it; Anthropic listing it is what settles it.
  expect(providerVersionBase("claude-opus-4-5", tree)).toBeNull();
  expect(providerVersionBase("claude-fable-5-1", tree)).toBeNull();
  expect(providerVersionBase("claude-opus-5", tree)).toBeNull();
  // No vendor directory is known for this family, so the source makes no claim either way.
  expect(providerVersionBase("llama-3-3-70b-2", tree)).toBeNull();
});

const catalogue = JSON.stringify({
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-opus-5": {
        id: "claude-opus-5",
        name: "Claude Opus 5",
        family: "claude-opus",
        release_date: "2026-07-24",
        limit: { context: 1000000, output: 128000 },
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    },
  },
  azure: {
    id: "azure",
    name: "Azure",
    models: {
      "claude-opus-5": { id: "claude-opus-5", name: "Claude Opus 5", release_date: "2026-07-24" },
      "claude-mythos-5": { id: "claude-mythos-5", name: "Claude Mythos 5", release_date: "2026-06-09", status: "beta" },
    },
  },
  "some-reseller": {
    id: "some-reseller",
    name: "Some Reseller",
    models: { "anthropic/claude-opus-5": { id: "anthropic/claude-opus-5", name: "Claude Opus 5" } },
  },
});

test("a launch is one record whose provider count climbs, not one record per shop selling it", async () => {
  const collection = await collectModelsDev(async () => new Response(catalogue));

  expect(collection.source).toBe("models-dev");
  expect(collection.records).toHaveLength(2);
  expect(collection.records[1]).toMatchObject({
    id: "claude-opus-5",
    name: "Claude Opus 5",
    released: "2026-07-24",
    context: 1000000,
    providerCount: 3,
    vendorListed: true,
  });
  // The reseller is counted but stays out of the body, so its next catalogue edit is not a change.
  expect(collection.records[1]?.coreProviders).toEqual(["anthropic", "azure"]);
});

test("a model only a cloud lists is reported as exactly that", async () => {
  const collection = await collectModelsDev(async () => new Response(catalogue));

  expect(collection.records[0]).toMatchObject({ id: "claude-mythos-5", vendorListed: false, providerCount: 1 });
});

const treePayload = JSON.stringify({
  truncated: false,
  tree: [
    { path: "providers/anthropic/claude-opus-5.yaml", type: "blob" },
    { path: "providers/microsoft-foundry/claude-opus-5.yaml", type: "blob" },
    { path: "providers/microsoft-foundry/claude-opus-5-2.yaml", type: "blob" },
    { path: "providers/openrouter/anthropic/claude-opus-5.yaml", type: "blob" },
  ],
});

/** How the tree actually files Grok on Azure: the same deployment at two depths. */
const nestedPayload = JSON.stringify({
  truncated: false,
  tree: [
    { path: "providers/microsoft-foundry/azure_ai/global/grok-3.yaml", type: "blob" },
    { path: "providers/microsoft-foundry/grok-3.yaml", type: "blob" },
  ],
});

test("one deployment filed at two depths is one record, not a duplicate ID", async () => {
  const collection = await collectTrueFoundryAzure("token", async () => new Response(nestedPayload));

  expect(collection.records).toHaveLength(1);
  expect(collection.records[0]).toMatchObject({
    id: "microsoft-foundry/grok-3",
    url: "https://github.com/truefoundry/models/blob/main/providers/microsoft-foundry/grok-3.yaml",
  });
});

test("a Foundry deployment version merges into the model it deploys", async () => {
  const seen: string[] = [];
  const collection = await collectTrueFoundryAzure("token", async (_url, init) => {
    seen.push(new Headers(init?.headers).get("authorization") ?? "");
    return new Response(treePayload);
  });

  expect(seen[0]).toBe("Bearer token");
  // Only the Azure directories are reported; the rest of the tree answered the vendor question.
  expect(collection.records).toHaveLength(2);
  expect(collection.records[0]).toMatchObject({
    id: "microsoft-foundry/claude-opus-5",
    canonical_id: "claude-opus-5",
    providerVersionOf: null,
    vendorListed: true,
  });
  // The deployment version carries the same canonical ID, so it never lands as a release of its own.
  expect(collection.records[1]).toMatchObject({
    id: "microsoft-foundry/claude-opus-5-2",
    canonical_id: "claude-opus-5",
    providerVersionOf: "claude-opus-5",
    vendorListed: false,
  });
});

test("a truncated tree is a malformed collection, never a shorter catalogue", async () => {
  const truncated = JSON.stringify({ truncated: true, tree: [{ path: "providers/a/b.yaml", type: "blob" }] });
  expect(collectTrueFoundryAzure("token", async () => new Response(truncated))).rejects.toThrow("truncated");
});

test("the catalogue is never read without a credential", async () => {
  expect(collectTrueFoundryAzure("", async () => new Response(treePayload))).rejects.toThrow("GITHUB_TOKEN");
});
