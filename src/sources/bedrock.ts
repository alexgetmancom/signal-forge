import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Collection, RecordData } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import { fetchText } from "./http.js";

/**
 * A model reaching Bedrock is evidence it shipped, and the regions it reaches say how far. "Kimi K3"
 * appeared in us-west-2 alone on 2026-09-18 and "GPT-6 Astra" in eu-west-3 alone on 2026-09-09;
 * neither was seen here, because only Bedrock's lifecycle page was read.
 *
 * These are the regions every account has without opting in. An opt-in region answers a refusal
 * to an account that never enabled it, and a region that cannot be read fails the whole read: a
 * model missing from one unread region is not a model withdrawn from it.
 */
export const BEDROCK_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "ca-central-1",
  "sa-east-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "eu-north-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
] as const;

const summarySchema = z.object({
  modelSummaries: z.array(
    z.object({
      modelId: z.string().min(1),
      modelName: z.string().nullish(),
      providerName: z.string().nullish(),
      inputModalities: z.array(z.string()).nullish(),
      outputModalities: z.array(z.string()).nullish(),
      inferenceTypesSupported: z.array(z.string()).nullish(),
      modelLifecycle: z.object({ status: z.string() }).nullish(),
    }),
  ),
});

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const hmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value).digest();

/** AWS Signature Version 4 for a GET without a query or body, which is the only request made here. */
export function signBedrockRequest(
  host: string,
  path: string,
  region: string,
  credentials: { accessKeyId: string; secretAccessKey: string },
  now: Date,
): Record<string, string> {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256("");
  const canonical = ["GET", path, "", `host:${host}`, `x-amz-date:${amzDate}`, "", "host;x-amz-date", payloadHash].join(
    "\n",
  );
  const scope = `${day}/${region}/bedrock/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  let key = hmac(`AWS4${credentials.secretAccessKey}`, day);
  for (const part of [region, "bedrock", "aws4_request"]) key = hmac(key, part);
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return {
    accept: "application/json",
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=host;x-amz-date, Signature=${signature}`,
  };
}

const sorted = (values: readonly string[] | null | undefined) => [...(values ?? [])].sort();

export async function collectBedrock(
  config: AppConfig,
  request: Fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<Collection> {
  const accessKeyId = config.AWS_ACCESS_KEY_ID;
  const secretAccessKey = config.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey)
    throw new Error("Bedrock catalogue needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY");
  const models = new Map<string, RecordData & { regions: string[] }>();
  const raw: Record<string, unknown> = {};
  for (const region of BEDROCK_REGIONS) {
    const host = `bedrock.${region}.amazonaws.com`;
    const path = "/foundation-models";
    const headers = signBedrockRequest(host, path, region, { accessKeyId, secretAccessKey }, now());
    const body: unknown = JSON.parse(await fetchText(`https://${host}${path}`, headers, request));
    raw[region] = body;
    for (const model of summarySchema.parse(body).modelSummaries) {
      const known = models.get(model.modelId);
      if (known) {
        known.regions.push(region);
        continue;
      }
      models.set(model.modelId, {
        id: model.modelId,
        name: model.modelName || model.modelId,
        maker: model.providerName || "AWS Bedrock",
        input: sorted(model.inputModalities),
        output: sorted(model.outputModalities),
        inference: sorted(model.inferenceTypesSupported),
        ...(model.modelLifecycle ? { lifecycle: model.modelLifecycle.status } : {}),
        regions: [region],
      });
    }
  }
  if (!models.size) throw new Error("Bedrock catalogue has no models");
  const records = [...models.values()].map((model) => ({ ...model, regions: [...model.regions].sort() }));
  return {
    source: "bedrock",
    stream: "api-models",
    url: "https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html",
    raw,
    records,
  };
}
