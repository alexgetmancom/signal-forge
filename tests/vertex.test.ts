import { expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { notificationBlock } from "../src/events/notification.js";
import { signalClass } from "../src/events/signals.js";
import type { Event } from "../src/events/types.js";
import {
  collectVertexModelGarden,
  collectVertexQuotas,
  MODEL_GARDEN_PUBLISHERS,
  signedAssertion,
} from "../src/sources/vertex.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const account = {
  type: "service_account",
  project_id: "tasknotes-486221",
  client_email: "signal-forge-reader@tasknotes-486221.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  token_uri: "https://oauth2.googleapis.com/token" as const,
};
const config = {
  ...loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname }),
  GOOGLE_CLOUD_SERVICE_ACCOUNT: JSON.stringify(account),
};

function google(pages: Record<string, unknown>[], seen: string[] = []) {
  let page = 0;
  return async (url: string, init?: RequestInit) => {
    seen.push(`${init?.method ?? "GET"} ${url} ${new Headers(init?.headers).get("authorization") ?? ""}`);
    if (url === account.token_uri) return Response.json({ access_token: "token-1", expires_in: 3599 });
    return Response.json(pages[page++]);
  };
}

test("the assertion is an RS256 token Google can verify with the service account's public key", async () => {
  const token = await signedAssertion(account, Date.parse("2026-09-17T00:00:00Z"));
  const [header, claims, signature] = token.split(".") as [string, string, string];
  expect(verify("sha256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, "base64url"))).toBe(
    true,
  );
  expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toMatchObject({
    iss: account.client_email,
    aud: account.token_uri,
    exp: 1789603200 + 3600,
  });
});

test("quotas are read for the key's project and folded into one record per base model", async () => {
  const seen: string[] = [];
  const quota = (quotaId: string, model: string, values: string[]) => ({
    quotaId,
    dimensionsInfos: values.map((value, index) => ({
      dimensions: { base_model: model, region: `r${index}` },
      details: { value },
    })),
  });
  const collection = await collectVertexQuotas(
    config,
    google(
      [
        {
          quotaInfos: [quota("InputTokensPerMinute", "grok-4.7", ["47000", "20000"]), { quotaId: "Unrelated" }],
          nextPageToken: "p2",
        },
        {
          quotaInfos: [
            quota("RequestsPerMinute", "grok-4.7", ["3"]),
            quota("RequestsPerMinute", "grok-4.6", ["60"]),
            {
              quotaId: "RequestsPerMinute",
              dimensionsInfos: [{ dimensions: { base_model: "grok-4.5" }, details: {} }],
            },
          ],
        },
      ],
      seen,
    ),
  );
  expect(seen.filter((line) => line.startsWith("POST"))).toHaveLength(1);
  expect(seen[1]).toContain(
    "/projects/tasknotes-486221/locations/global/services/aiplatform.googleapis.com/quotaInfos",
  );
  expect(seen[1]).toEndWith("Bearer token-1");
  expect(seen[2]).toContain("pageToken=p2");
  expect(seen.join("\n")).not.toContain("PRIVATE KEY");
  expect(collection.records).toEqual([
    { id: "grok-4.6", name: "grok-4.6", maker: "Vertex AI", limits: { RequestsPerMinute: 60 } },
    {
      id: "grok-4.7",
      name: "grok-4.7",
      maker: "Vertex AI",
      limits: { InputTokensPerMinute: 47000, RequestsPerMinute: 3 },
    },
  ]);
});

test("a quota answer without any base model is a failed read, not an empty catalogue", async () => {
  await expect(collectVertexQuotas(config, google([{ quotaInfos: [{ quotaId: "Unrelated" }] }]))).rejects.toThrow(
    "no base_model",
  );
});

test("a malformed key fails without repeating any of it", async () => {
  const broken = { ...config, GOOGLE_CLOUD_SERVICE_ACCOUNT: `{"private_key": "${account.private_key.slice(0, 40)}` };
  const error = await collectVertexQuotas(broken, google([])).catch((caught: Error) => caught);
  expect(String(error)).toContain("not JSON");
  expect(String(error)).not.toContain("PRIVATE");
});

test("Model Garden is read for every publisher and ids carry the publisher", async () => {
  const seen: string[] = [];
  const request = async (url: string) => {
    seen.push(url);
    if (url === account.token_uri) return Response.json({ access_token: "token-1", expires_in: 3599 });
    const publisher = /publishers\/([^/]+)\/models/.exec(url)?.[1] ?? "";
    if (publisher === "google" && !url.includes("pageToken"))
      return Response.json({ publisherModels: [{ name: "publishers/google/models/gemini-3" }], nextPageToken: "g2" });
    return Response.json({
      publisherModels: [
        { name: `publishers/${publisher}/models/${publisher}-model`, versionId: "001", launchStage: "GA" },
      ],
    });
  };
  const collection = await collectVertexModelGarden(config, request);
  expect(collection.records).toHaveLength(MODEL_GARDEN_PUBLISHERS.length + 1);
  expect(seen.some((url) => url.includes("publishers/google/models?pageSize=100&pageToken=g2"))).toBe(true);
  expect(collection.records).toContainEqual({
    id: "xai/xai-model",
    name: "xai-model",
    maker: "Vertex AI",
    url: "https://console.cloud.google.com/vertex-ai/publishers/xai/model-garden/xai-model",
    version: "001",
    stage: "GA",
  });
});

test("a publisher answering with no models fails the read instead of emptying its catalogue", async () => {
  const request = async (url: string) =>
    url === account.token_uri
      ? Response.json({ access_token: "token-1", expires_in: 3599 })
      : Response.json(url.includes("publishers/meta/") ? {} : { publisherModels: [{ name: "publishers/x/models/y" }] });
  await expect(collectVertexModelGarden(config, request)).rejects.toThrow("no models for meta");
});

const event = (source: string, kind: Event["kind"], before: object | null, after: object | null): Event => ({
  id: 1,
  source,
  stream: "api-models",
  entity_id: "grok-4.7",
  kind,
  before_json: before ? JSON.stringify(before) : null,
  after_json: after ? JSON.stringify(after) : null,
  detected_at: "2026-09-17T00:00:00.000Z",
});

test("a Grok quota or listing on Vertex is a sighting, and a quota moving is silent", () => {
  const record = { id: "grok-4.7", name: "grok-4.7", maker: "Vertex AI", limits: { RequestsPerMinute: 3 } };
  expect(signalClass(event("vertex-quotas", "new", null, record))).toBe("codename");
  expect(signalClass(event("vertex-model-garden", "new", null, { id: "grok-4.7", name: "grok-4.7" }))).toBe("codename");
  expect(
    notificationBlock(event("vertex-quotas", "changed", record, { ...record, limits: { RequestsPerMinute: 60 } })),
  ).toBe("A project quota moved, not the model");
});
