import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Collection, RecordData } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import { fetchText } from "./http.js";

/**
 * Google Cloud answers both reads below only for a project, and only with an OAuth token minted from
 * a service account. The credential is the service account's JSON key, carried whole in one
 * variable; its `project_id` is the project being read, so there is no second setting to disagree
 * with it.
 */
const serviceAccountSchema = z.object({
  project_id: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().includes("PRIVATE KEY"),
  token_uri: z.literal("https://oauth2.googleapis.com/token"),
});
type ServiceAccount = z.infer<typeof serviceAccountSchema>;

const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() });

function serviceAccount(config: AppConfig): ServiceAccount {
  const value = config.GOOGLE_CLOUD_SERVICE_ACCOUNT;
  if (!value) throw new Error("Vertex needs GOOGLE_CLOUD_SERVICE_ACCOUNT");
  // Neither error may carry the text it failed on: it is a private key.
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("GOOGLE_CLOUD_SERVICE_ACCOUNT is not JSON");
  }
  const result = serviceAccountSchema.safeParse(parsed);
  if (!result.success) throw new Error("GOOGLE_CLOUD_SERVICE_ACCOUNT is not a service account key");
  return result.data;
}

const base64url = (bytes: Uint8Array | string): string => Buffer.from(bytes).toString("base64url");

/** A signed assertion exchanged for a token, as Google's OAuth server-to-server flow defines it. */
export async function signedAssertion(account: ServiceAccount, now = Date.now()): Promise<string> {
  const issued = Math.floor(now / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: account.token_uri,
      iat: issued,
      exp: issued + 3600,
    }),
  )}`;
  const der = Buffer.from(account.private_key.replace(/-----[^-]+-----|\s/g, ""), "base64");
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

// Two sources poll with one credential; an hour-long token is minted once, not twice an interval.
const tokens = new Map<string, { token: string; until: number }>();

async function accessToken(account: ServiceAccount, request: Fetch): Promise<string> {
  const cached = tokens.get(account.client_email);
  if (cached && cached.until > Date.now()) return cached.token;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: await signedAssertion(account),
  }).toString();
  const answer = tokenSchema.parse(
    JSON.parse(
      await fetchText(account.token_uri, { "content-type": "application/x-www-form-urlencoded" }, request, {
        method: "POST",
        body,
      }),
    ),
  );
  tokens.set(account.client_email, {
    token: answer.access_token,
    until: Date.now() + (answer.expires_in - 300) * 1000,
  });
  return answer.access_token;
}

async function authorized(config: AppConfig, request: Fetch) {
  const account = serviceAccount(config);
  const token = await accessToken(account, request);
  return {
    project: account.project_id,
    headers: {
      Authorization: `Bearer ${token}`,
      "x-goog-user-project": account.project_id,
      accept: "application/json",
    },
  };
}

const quotaInfosSchema = z.object({
  quotaInfos: z
    .array(
      z.object({
        quotaId: z.string().min(1),
        dimensionsInfos: z
          .array(
            z.object({
              dimensions: z.record(z.string(), z.string()).optional(),
              // A dimension with no limit of its own answers `details: {}`: 1,817 of 5,904 did for the
              // owner's project on 2026-09-17.
              details: z
                .object({
                  value: z
                    .string()
                    .regex(/^-?\d+$/)
                    .optional(),
                })
                .optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

/**
 * Vertex quotas carry a `base_model` dimension for every partner model a project may call, and the
 * dimension arrives before the model is in Model Garden: on 2026-09-17 `base_model:grok-4.7` was
 * answered by the Cloud Quotas API for the owner's project (47,000 input and 4,000 output tokens,
 * 3 requests a minute) while Model Garden's newest xAI entry was `grok-4.6`. A quota is a platform
 * preparing to serve a model, not the model being served, which is why it is a sighting.
 *
 * The limits are this project's allowance and move when the owner adjusts them; they are evidence
 * and never a change worth a card.
 */
export async function collectVertexQuotas(config: AppConfig, request: Fetch = fetch): Promise<Collection> {
  const { project, headers } = await authorized(config, request);
  const apiUrl = `https://cloudquotas.googleapis.com/v1/projects/${project}/locations/global/services/aiplatform.googleapis.com/quotaInfos?pageSize=500`;
  const raw: unknown[] = [];
  const models = new Map<string, Record<string, number>>();
  let quotaCount = 0;
  let cursor = "";
  for (let page = 0; page < 100; page++) {
    const body: unknown = JSON.parse(
      await fetchText(`${apiUrl}${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ""}`, headers, request),
    );
    const data = quotaInfosSchema.parse(body);
    raw.push(body);
    for (const quota of data.quotaInfos ?? []) {
      quotaCount++;
      for (const info of quota.dimensionsInfos ?? []) {
        const model = info.dimensions?.base_model;
        if (!model || info.details?.value === undefined) continue;
        const limits = models.get(model) ?? {};
        limits[quota.quotaId] = Math.max(limits[quota.quotaId] ?? -1, Number(info.details.value));
        models.set(model, limits);
      }
    }
    if (!data.nextPageToken) {
      // A project that lost the API answers with no quotas; that is a broken read, not every
      // partner model leaving Google Cloud at once.
      if (!quotaCount || !models.size) throw new Error("Vertex quotas have no base_model dimension");
      const records: RecordData[] = [...models.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([model, limits]) => ({
          id: model,
          name: model,
          maker: "Vertex AI",
          limits: Object.fromEntries(Object.entries(limits).sort(([left], [right]) => left.localeCompare(right))),
        }));
      return {
        source: "vertex-quotas",
        stream: "api-models",
        url: "https://console.cloud.google.com/iam-admin/quotas",
        raw,
        records,
      };
    }
    if (data.nextPageToken === cursor) throw new Error("Vertex quota pagination did not advance");
    cursor = data.nextPageToken;
  }
  throw new Error("Vertex quota pagination exceeded limit");
}

const publisherModelsSchema = z.object({
  publisherModels: z
    .array(
      z.object({
        name: z.string().regex(/^publishers\/[^/]+\/models\/[^/]+$/),
        versionId: z.string().optional(),
        launchStage: z.string().optional(),
      }),
    )
    .min(1),
  nextPageToken: z.string().optional(),
});

/**
 * Model Garden is where a partner model becomes something a Google Cloud customer can deploy. Only
 * the xAI publisher is read: it is the one whose listing was measured answering, on 2026-09-17 from
 * us-central1 with `grok-4.6` newest, and the one whose quota ran ahead of its listing.
 */
export async function collectVertexModelGarden(config: AppConfig, request: Fetch = fetch): Promise<Collection> {
  const { headers } = await authorized(config, request);
  const apiUrl = "https://us-central1-aiplatform.googleapis.com/v1beta1/publishers/xai/models?pageSize=100";
  const raw: unknown[] = [];
  const records: RecordData[] = [];
  let cursor = "";
  for (let page = 0; page < 100; page++) {
    const body: unknown = JSON.parse(
      await fetchText(`${apiUrl}${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ""}`, headers, request),
    );
    const data = publisherModelsSchema.parse(body);
    raw.push(body);
    records.push(
      ...data.publisherModels.map((model) => {
        const id = model.name.split("/").at(-1) ?? model.name;
        return {
          id,
          name: id,
          maker: "Vertex AI",
          url: `https://console.cloud.google.com/vertex-ai/publishers/xai/model-garden/${id}`,
          ...(model.versionId ? { version: model.versionId } : {}),
          ...(model.launchStage ? { stage: model.launchStage } : {}),
        };
      }),
    );
    if (!data.nextPageToken) {
      return {
        source: "vertex-model-garden",
        stream: "api-models",
        url: "https://console.cloud.google.com/vertex-ai/model-garden",
        raw,
        records,
      };
    }
    if (data.nextPageToken === cursor) throw new Error("Model Garden pagination did not advance");
    cursor = data.nextPageToken;
  }
  throw new Error("Model Garden pagination exceeded limit");
}
