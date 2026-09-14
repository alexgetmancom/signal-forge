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

test("a created that is only the time of the answer is not collected as a date", async () => {
  const mistral = PROVIDER_CATALOGUES.find((provider) => provider.id === "mistral");
  const answeredAt = Math.floor(Date.now() / 1000);
  // What Mistral actually answers: one identical created for every model, equal to now. Stored, it
  // was a change event per model per poll and a releaseDate of the last collection in Model Facts.
  const collection = await collectProviderCatalogue(
    mistral!,
    { ...config, MISTRAL_API_KEY: "secret" },
    async () =>
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            { id: "mistral-large-latest", object: "model", created: answeredAt, owned_by: "mistralai" },
            { id: "codestral-latest", object: "model", created: answeredAt, owned_by: "mistralai" },
          ],
        }),
      ),
  );

  expect(collection.records).toHaveLength(2);
  for (const record of collection.records) expect(record).not.toHaveProperty("created");
  // A provider that answers with real per-model dates keeps them.
  expect((await collectProviderCatalogue(zai!, config, async () => new Response(payload))).records[1]).toHaveProperty(
    "created",
    "2026-02-10T16:00:00.000Z",
  );
});

test("a provider with no key configured is not collected", async () => {
  const groq = PROVIDER_CATALOGUES.find((provider) => provider.id === "groq");
  expect(collectProviderCatalogue(groq!, config, async () => new Response(payload))).rejects.toThrow("GROQ_API_KEY");
});
