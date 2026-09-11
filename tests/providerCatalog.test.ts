import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { collectProviderCatalogue, PROVIDER_CATALOGUES } from "../src/sources/catalogs.js";

const config = {
  ...loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname }),
  ZAI_API_KEY: "secret",
};

const zai = PROVIDER_CATALOGUES.find((provider) => provider.id === "zai");

// The shape Z.ai actually answers with, which is the shape OpenAI defined.
const payload = JSON.stringify({
  object: "list",
  data: [
    { id: "glm-4.6", object: "model", created: 1759276800, owned_by: "z-ai" },
    { id: "glm-5", object: "model", created: 1770739200, owned_by: "z-ai" },
  ],
});

test("a provider catalogue is read with the key and never with the key in the address", async () => {
  const seen: { url: string; authorization: string | null }[] = [];
  const collection = await collectProviderCatalogue(zai!, config, async (url, init) => {
    seen.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
    return new Response(payload, { headers: { "content-type": "application/json" } });
  });

  expect(seen[0]?.url).toBe("https://api.z.ai/api/paas/v4/models");
  expect(seen[0]?.url).not.toContain("secret");
  expect(seen[0]?.authorization).toBe("Bearer secret");
  expect(collection.source).toBe("zai");
  expect(collection.stream).toBe("api-models");
  expect(collection.records).toHaveLength(2);
  expect(collection.records[1]).toMatchObject({
    id: "glm-5",
    name: "glm-5",
    maker: "Z.ai",
    created: "2026-02-10T16:00:00.000Z",
  });
});

test("an empty catalogue is a failed read, never an empty catalogue", async () => {
  expect(
    collectProviderCatalogue(zai!, config, async () => new Response(JSON.stringify({ object: "list", data: [] }))),
  ).rejects.toThrow();
});

test("a provider with no key configured is not collected", async () => {
  const groq = PROVIDER_CATALOGUES.find((provider) => provider.id === "groq");
  expect(collectProviderCatalogue(groq!, config, async () => new Response(payload))).rejects.toThrow("GROQ_API_KEY");
});
