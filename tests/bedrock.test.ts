import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { BEDROCK_REGIONS, collectBedrock, signBedrockRequest } from "../src/sources/bedrock.js";

const config = {
  ...loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname }),
  AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const now = () => new Date("2026-09-18T03:27:00.000Z");

function summaries(...ids: string[]) {
  return JSON.stringify({
    modelSummaries: ids.map((modelId) => ({
      modelId,
      modelName: modelId === "moonshotai.kimi-k3" ? "Kimi K3" : modelId,
      providerName: "Moonshot AI",
      inputModalities: ["TEXT"],
      outputModalities: ["TEXT"],
      inferenceTypesSupported: ["ON_DEMAND"],
      modelLifecycle: { status: "ACTIVE" },
    })),
  });
}

// The expected signature is what AWS's own @smithy/signature-v4 produced for the same request.
test("a Bedrock request is signed for its own region and never carries the secret", () => {
  const headers = signBedrockRequest(
    "bedrock.us-west-2.amazonaws.com",
    "/foundation-models",
    "us-west-2",
    { accessKeyId: "AKIDEXAMPLE", secretAccessKey: config.AWS_SECRET_ACCESS_KEY },
    now(),
  );
  expect(headers["x-amz-date"]).toBe("20260918T032700Z");
  expect(headers.authorization).toBe(
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260918/us-west-2/bedrock/aws4_request, SignedHeaders=host;x-amz-date, Signature=61f7a159d5c20c2479b3e0d3966a204a8d5542278405abf3b068f6f59b291591",
  );
  expect(JSON.stringify(headers)).not.toContain("wJalrXUtnFEMI");
});

test("one model is one record carrying every region it reached", async () => {
  const collection = await collectBedrock(
    config,
    async (input) => {
      const region = new URL(String(input)).host.split(".")[1];
      const ids =
        region === "us-west-2" ? ["anthropic.claude-opus-5", "moonshotai.kimi-k3"] : ["anthropic.claude-opus-5"];
      return new Response(summaries(...ids), { headers: { "content-type": "application/json" } });
    },
    now,
  );
  const kimi = collection.records.find((record) => record.id === "moonshotai.kimi-k3");
  const opus = collection.records.find((record) => record.id === "anthropic.claude-opus-5");
  expect(kimi).toMatchObject({ name: "Kimi K3", maker: "Moonshot AI", regions: ["us-west-2"] });
  expect(opus?.regions).toEqual([...BEDROCK_REGIONS].sort());
});

test("a region that cannot be read fails the read instead of withdrawing its models", async () => {
  const read = collectBedrock(
    config,
    async (input) =>
      new URL(String(input)).host.includes("eu-west-3")
        ? new Response("denied", { status: 403 })
        : new Response(summaries("openai.gpt-6-astra"), { headers: { "content-type": "application/json" } }),
    now,
  );
  await expect(read).rejects.toThrow();
});

test("the Bedrock catalogue is not read without both halves of the key", async () => {
  const { AWS_SECRET_ACCESS_KEY: _, ...partial } = config;
  await expect(collectBedrock(partial as never, async () => new Response(summaries("x")), now)).rejects.toThrow(
    "AWS_SECRET_ACCESS_KEY",
  );
});
